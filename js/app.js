import { geocodeCities, geocodeLieux, parseCoords } from "./geocode.js";

const YAML_PATH = "tournee.yaml";
const DEPARTMENTS_PATH = "data/departements.geojson";
const DEPT_MAX_ZOOM = 8;

let map;
let layerGroup;
let placesLayer;
let departmentsLayer;
let markers = [];
let placeMarkers = [];
let timelineItems = [];
let stops = [];
let theme = {};
let activeStopId = null;

const titleEl = document.getElementById("tour-title");
const subtitleEl = document.getElementById("tour-subtitle");
const metaEl = document.getElementById("tour-meta");
const timelineEl = document.getElementById("timeline");
const statusEl = document.getElementById("map-status");
const detailPanel = document.getElementById("detail-panel");
const detailContent = document.getElementById("detail-content");
const detailClose = document.getElementById("detail-close");

init();
detailClose.addEventListener("click", () => closeDetail());

function init() {
  map = L.map("map", {
    zoomControl: false,
    scrollWheelZoom: true,
  }).setView([46.6, 2.5], 6);

  L.control.zoom({ position: "bottomright" }).addTo(map);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    subdomains: "abc",
    maxZoom: 19,
  }).addTo(map);

  layerGroup = L.layerGroup().addTo(map);
  placesLayer = L.layerGroup().addTo(map);
  loadDepartmentsLayer();
  loadTour();
}

async function loadDepartmentsLayer() {
  try {
    const response = await fetch(DEPARTMENTS_PATH);
    if (!response.ok) return;

    const geojson = await response.json();
    departmentsLayer = L.geoJSON(geojson, {
      style: {
        fillColor: "#e8e4de",
        fillOpacity: 0.68,
        color: "#b8b0a6",
        weight: 1.25,
        opacity: 1,
        interactive: false,
      },
      onEachFeature(feature, layer) {
        const code = feature.properties?.code;
        if (!code) return;

        layer.bindTooltip(escapeHtml(code), {
          permanent: true,
          direction: "center",
          className: "dept-label",
          interactive: false,
          opacity: 1,
        });
      },
    });

    map.on("zoomend", syncDepartmentsVisibility);
    syncDepartmentsVisibility();
  } catch (error) {
    console.warn("Impossible de charger les départements", error);
  }
}

function syncDepartmentsVisibility() {
  if (!departmentsLayer) return;

  const show = map.getZoom() <= DEPT_MAX_ZOOM;
  if (show && !map.hasLayer(departmentsLayer)) {
    departmentsLayer.addTo(map);
  } else if (!show && map.hasLayer(departmentsLayer)) {
    map.removeLayer(departmentsLayer);
  }
}

async function loadTour() {
  setStatus("Chargement…");

  try {
    const response = await fetch(`${YAML_PATH}?t=${Date.now()}`);
    if (!response.ok) {
      throw new Error(`Impossible de lire ${YAML_PATH} (${response.status})`);
    }

    const data = jsyaml.load(await response.text());
    stops = buildStops(data);

    if (!stops.length) {
      throw new Error("Aucune étape trouvée dans le YAML.");
    }

    setStatus("Géocodage des villes…");
    await geocodeCities(stops, (current, total, label) => {
      setStatus(`Villes ${current}/${total} — ${label}`);
    });

    const missingCities = stops.filter((stop) => !stop.coords).map((stop) => stop.city);
    if (missingCities.length) {
      throw new Error(`Villes introuvables : ${missingCities.join(", ")}`);
    }

    theme = data.theme || data.colors || {};
    applyTheme(theme);
    renderMeta(data.meta, stops);
    renderTimeline(stops);
    renderMap(stops);
    setStatus(`${stops.length} étapes chargées`, true);

    prefetchLieux(stops);
  } catch (error) {
    console.error(error);
    setStatus(error.message, false, true);
  }
}

function buildStops(data) {
  const rawSteps = data.steps || [];

  return rawSteps.map((step) => normalizeStep(step));
}

function normalizeStep(step) {
  const color = step.color || step.marker_color || "#EA580C";
  const details = step.details || {};
  const isArrival = step.type === "arrival";

  return {
    id: step.id,
    city: step.city,
    address: step.address?.trim() || "",
    coords: parseCoords(step.coords),
    dates: step.dates || step.dates?.label || "",
    days: step.days ?? step.dates?.days ?? null,
    color,
    phase: step.phase || "",
    type: step.type || "stop",
    isArrival,
    details: {
      title: details.title || step.city,
      summary: details.summary || "",
      lieux: normalizePlaces(details.lieux),
      agenda: details.agenda || [],
      notes: details.notes || [],
      links: details.links || [],
      contacts: details.contacts || [],
    },
  };
}

function normalizePlaces(places) {
  return (places || []).map((place, index) => ({
    id: place.id || `lieu-${index + 1}`,
    name: place.name || "Lieu",
    address: place.address?.trim() || "",
    query: place.query?.trim() || "",
    coords: parseCoords(place.coords),
    icon: place.icon ?? "📍",
    legend: place.legend || "",
  }));
}

async function prefetchLieux(allStops) {
  const stopsWithLieux = allStops.filter((stop) => stop.details.lieux.some((place) => !place.coords));
  if (!stopsWithLieux.length) return;

  for (const stop of stopsWithLieux) {
    const failures = await geocodeLieux(stop);
    if (failures.length) {
      console.warn(`Lieux non géocodés (${stop.city}) :`, failures);
    }

    if (activeStopId === stop.id) {
      renderPlaces(stop);
    }
  }
}

function applyTheme(colors) {
  const root = document.documentElement;
  if (colors.accent) root.style.setProperty("--accent", colors.accent);
  if (colors.background) root.style.setProperty("--bg", colors.background);
  if (colors.panel) root.style.setProperty("--panel", colors.panel);
}

function renderMeta(meta = {}, allStops) {
  titleEl.textContent = meta.title || "Tournée";
  subtitleEl.textContent = meta.subtitle || "";

  const totalDays = allStops.reduce((sum, stop) => sum + (Number(stop.days) || 0), 0);
  const period = meta.period ? ` · ${meta.period}` : "";
  metaEl.textContent = `${allStops.length} étapes · ${totalDays} jours${period}`;
}

function renderTimeline(allStops) {
  timelineEl.innerHTML = "";
  timelineItems = [];

  allStops.forEach((stop) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "timeline__item";
    item.dataset.stopId = String(stop.id);
    item.innerHTML = `
      <span class="timeline__dot" style="background:${stop.color}"></span>
      <div class="timeline__body">
        <p class="timeline__dates">${escapeHtml(formatPinDates(stop.dates))}${stop.days ? ` · ${stop.days} j` : ""}</p>
        <p class="timeline__city">${escapeHtml(stop.city)}${stop.isArrival ? " ★" : ""}</p>
        ${stop.phase ? `<p class="timeline__phase">${escapeHtml(stop.phase)}</p>` : ""}
      </div>
    `;

    item.addEventListener("click", () => focusStop(stop.id));
    timelineEl.appendChild(item);
    timelineItems.push({ id: stop.id, el: item });
  });
}

function renderMap(allStops) {
  layerGroup.clearLayers();
  markers = [];
  const bounds = [];

  allStops.forEach((stop) => {
    const marker = createMarker(stop);
    marker.setLatLng(stop.coords);
    marker.addTo(layerGroup);
    markers.push({ id: stop.id, marker });
    bounds.push(stop.coords);
  });

  if (bounds.length) {
    map.fitBounds(bounds, { padding: [60, 60] });
  }

  window.setTimeout(() => map.invalidateSize(), 0);
}

function createMarker(stop) {
  const pinDates = formatPinDates(stop.dates);
  const icon = L.divIcon({
    className: "map-marker",
    html: `
      <div class="map-marker__wrap">
        <div class="map-marker__dot" style="background:${stop.color}"></div>
        <div class="map-marker__label">${escapeHtml(pinDates)}</div>
      </div>
    `,
    iconSize: [0, 0],
    iconAnchor: [0, 0],
  });

  const marker = L.marker(stop.coords, { icon, riseOnHover: true });
  marker.bindPopup(`
    <p class="popup__title">${escapeHtml(stop.details.title || stop.city)}</p>
    <p class="popup__dates">${escapeHtml(stop.dates || "")}</p>
  `, { maxWidth: 220, closeButton: false });
  marker.on("click", () => focusStop(stop.id));
  marker.stopId = stop.id;
  return marker;
}

async function focusStop(stopId) {
  activeStopId = stopId;
  const stop = stops.find((s) => s.id === stopId);
  if (!stop) return;

  timelineItems.forEach(({ id, el }) => {
    el.classList.toggle("is-active", id === stopId);
  });

  markers.forEach(({ id, marker }) => {
    const el = marker.getElement();
    if (el) el.classList.toggle("is-active", id === stopId);
  });

  renderDetail(stop);
  detailPanel.classList.add("is-open");

  const pendingLieux = stop.details.lieux.some((place) => !place.coords);
  if (pendingLieux) {
    setStatus(`Lieux — ${stop.city}…`);
    const failures = await geocodeLieux(stop);
    if (failures.length) {
      console.warn(`Lieux non géocodés (${stop.city}) :`, failures);
    }
    setStatus(`${stops.length} étapes chargées`, true);
  }

  renderPlaces(stop);

  const item = timelineItems.find((t) => t.id === stopId)?.el;
  if (item) {
    item.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
}

function renderDetail(stop) {
  const d = stop.details;
  const sections = [];

  if (d.summary) {
    sections.push(`<p class="detail__summary">${escapeHtml(d.summary)}</p>`);
  }

  if (d.agenda?.length) {
    sections.push(renderListSection("Agenda", d.agenda));
  }

  if (d.notes?.length) {
    sections.push(renderListSection("Notes", d.notes));
  }

  if (d.links?.length) {
    sections.push(renderLinksSection(d.links));
  }

  if (d.contacts?.length) {
    sections.push(renderContactsSection(d.contacts));
  }

  if (d.lieux?.length) {
    sections.push(renderLieuxSection(d.lieux, stop.id));
  }

  const hasContent = sections.length > 0;
  const emptyHint = !hasContent
    ? `<p class="detail__empty">Ajoutez du contenu dans <code>details</code> : summary, lieux, agenda, notes…</p>`
    : "";

  detailContent.innerHTML = `
    ${stop.phase ? `<p class="detail__phase">${escapeHtml(stop.phase)}</p>` : ""}
    <h2 class="detail__title">${escapeHtml(d.title || stop.city)}</h2>
    <p class="detail__dates">${escapeHtml(stop.dates || "")}${stop.days ? ` · ${stop.days} jour(s)` : ""}</p>
    ${stop.address ? `<p class="detail__address">${escapeHtml(stop.address)}</p>` : ""}
    ${sections.join("")}
    ${emptyHint}
  `;
}

function renderLieuxSection(lieux, stopId) {
  const items = lieux.map((place) => `
    <button type="button" class="lieu-card" data-stop-id="${stopId}" data-place-id="${escapeHtml(place.id)}">
      <span class="lieu-card__icon">${renderPlaceIconHtml(place.icon)}</span>
      <span class="lieu-card__body">
        <strong>${escapeHtml(place.name)}</strong>
        ${place.address ? `<span class="lieu-card__address">${escapeHtml(place.address)}</span>` : ""}
        ${place.legend ? `<span>${escapeHtml(place.legend)}</span>` : ""}
      </span>
    </button>
  `).join("");

  return `
    <div class="detail__section">
      <h3>Lieux caractéristiques</h3>
      <div class="lieux-list">${items}</div>
    </div>
  `;
}

function renderPlaces(stop) {
  placesLayer.clearLayers();
  placeMarkers = [];

  (stop.details.lieux || []).forEach((place) => {
    const marker = createPlaceMarker(place, stop.id);
    marker.addTo(placesLayer);
    placeMarkers.push({ id: place.id, stopId: stop.id, marker });
  });

  detailContent.querySelectorAll(".lieu-card").forEach((card) => {
    card.addEventListener("click", () => {
      const placeId = card.dataset.placeId;
      openPlaceLegend(placeId, stop.id);
    });
  });
}

function createPlaceMarker(place, stopId) {
  const iconHtml = renderPlaceIconHtml(place.icon, "place-marker__icon");
  const icon = L.divIcon({
    className: "place-marker",
    html: `<div class="place-marker__wrap">${iconHtml}</div>`,
    iconSize: [36, 36],
    iconAnchor: [18, 18],
  });

  const marker = L.marker(place.coords, { icon, riseOnHover: true });
  marker.bindPopup(buildPlacePopup(place), {
    maxWidth: 280,
    className: "place-popup",
    closeButton: true,
  });
  marker.on("click", () => {
    highlightPlace(place.id);
    marker.openPopup();
  });
  marker.placeId = place.id;
  marker.stopId = stopId;
  return marker;
}

function buildPlacePopup(place) {
  return `
    <div class="place-popup__content">
      <div class="place-popup__header">
        ${renderPlaceIconHtml(place.icon, "place-popup__icon")}
        <h4 class="place-popup__title">${escapeHtml(place.name)}</h4>
      </div>
      ${place.legend ? `<p class="place-popup__legend">${escapeHtml(place.legend)}</p>` : ""}
    </div>
  `;
}

function openPlaceLegend(placeId, stopId) {
  const entry = placeMarkers.find((p) => p.id === placeId && p.stopId === stopId);
  if (!entry) return;

  highlightPlace(placeId);
  entry.marker.openPopup();
}

function highlightPlace(placeId) {
  placeMarkers.forEach(({ id, marker }) => {
    const el = marker.getElement();
    if (el) el.classList.toggle("is-active", id === placeId);
  });

  detailContent.querySelectorAll(".lieu-card").forEach((card) => {
    card.classList.toggle("is-active", card.dataset.placeId === placeId);
  });
}

function clearPlaces() {
  placesLayer.clearLayers();
  placeMarkers = [];
}

function renderPlaceIconHtml(icon, className = "place-icon") {
  const baseClass = escapeHtml(className);

  if (!icon) {
    return `<span class="${baseClass} ${baseClass}--default">📍</span>`;
  }

  if (typeof icon === "string") {
    if (isImagePath(icon)) {
      return `<img class="${baseClass} ${baseClass}--img" src="${escapeHtml(icon)}" alt="" />`;
    }
    return `<span class="${baseClass} ${baseClass}--emoji">${escapeHtml(icon)}</span>`;
  }

  const src = icon.image || icon.src;
  if (src) {
    if (icon.color) {
      return renderTintedSvgIcon(src, icon.color, baseClass);
    }
    return `<img class="${baseClass} ${baseClass}--img" src="${escapeHtml(src)}" alt="" />`;
  }

  if (icon.emoji) {
    return `<span class="${baseClass} ${baseClass}--emoji">${escapeHtml(icon.emoji)}</span>`;
  }

  if (icon.color) {
    const symbol = icon.symbol || icon.label || "•";
    return `<span class="${baseClass} ${baseClass}--color" style="background:${escapeHtml(icon.color)}">${escapeHtml(symbol)}</span>`;
  }

  return `<span class="${baseClass} ${baseClass}--default">📍</span>`;
}

function renderTintedSvgIcon(src, color, baseClass) {
  const url = escapeHtml(src);
  const tint = escapeHtml(color);
  const mask = [
    `-webkit-mask-image:url('${url}')`,
    `mask-image:url('${url}')`,
    "-webkit-mask-size:contain",
    "mask-size:contain",
    "-webkit-mask-repeat:no-repeat",
    "mask-repeat:no-repeat",
    "-webkit-mask-position:center",
    "mask-position:center",
  ].join(";");

  return `<span class="${baseClass} place-icon-tinted" aria-hidden="true"><span class="place-icon-tinted__glyph" style="background-color:${tint};${mask}"></span></span>`;
}

function isImagePath(value) {
  return /^(https?:\/\/|\/|assets\/|\.\/)/i.test(value)
    || /\.(svg|png|jpe?g|gif|webp)$/i.test(value);
}

function renderListSection(title, items) {
  const lis = items.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
  return `
    <div class="detail__section">
      <h3>${escapeHtml(title)}</h3>
      <ul class="detail__list">${lis}</ul>
    </div>
  `;
}

function renderLinksSection(links) {
  const items = links.map((link) => {
    if (typeof link === "string") {
      return `<a href="${escapeHtml(link)}" target="_blank" rel="noopener">${escapeHtml(link)}</a>`;
    }
    const url = link.url || "#";
    const label = link.label || link.url || "Lien";
    return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(label)}</a>`;
  }).join("");

  return `
    <div class="detail__section">
      <h3>Liens</h3>
      <div class="detail__links">${items}</div>
    </div>
  `;
}

function renderContactsSection(contacts) {
  const cards = contacts.map((contact) => {
    if (typeof contact === "string") {
      return `<div class="contact-card"><strong>${escapeHtml(contact)}</strong></div>`;
    }
    return `
      <div class="contact-card">
        <strong>${escapeHtml(contact.name || "")}</strong>
        ${contact.role ? `<span>${escapeHtml(contact.role)}</span>` : ""}
        ${contact.phone ? `<span>${escapeHtml(contact.phone)}</span>` : ""}
        ${contact.email ? `<span>${escapeHtml(contact.email)}</span>` : ""}
      </div>
    `;
  }).join("");

  return `
    <div class="detail__section">
      <h3>Contacts</h3>
      <div class="detail__contacts">${cards}</div>
    </div>
  `;
}

function closeDetail() {
  detailPanel.classList.remove("is-open");
  activeStopId = null;
  clearPlaces();
  timelineItems.forEach(({ el }) => el.classList.remove("is-active"));
  markers.forEach(({ marker }) => {
    const el = marker.getElement();
    if (el) el.classList.remove("is-active");
  });
}

function formatPinDates(dates) {
  if (!dates) return "—";
  return String(dates)
    .replace(/janvier/gi, "janv.")
    .replace(/février/gi, "fév.")
    .replace(/fevrier/gi, "fév.")
    .replace(/avril/gi, "avr.")
    .replace(/juillet/gi, "juil.")
    .replace(/août/gi, "août")
    .replace(/aout/gi, "août")
    .replace(/septembre/gi, "sept.")
    .replace(/octobre/gi, "oct.")
    .replace(/novembre/gi, "nov.")
    .replace(/décembre/gi, "déc.")
    .replace(/decembre/gi, "déc.");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function setStatus(message, hideSoon = false, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.remove("is-hidden", "is-error");
  if (isError) statusEl.classList.add("is-error");
  if (hideSoon) {
    window.setTimeout(() => statusEl.classList.add("is-hidden"), 2200);
  }
}
