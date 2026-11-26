import { Capacitor, CapacitorHttp, registerPlugin } from "@capacitor/core";
import { LocalNotifications } from "@capacitor/local-notifications";
import { TextToSpeech } from "@capacitor-community/text-to-speech";
import { Filesystem, Directory } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
import { Haptics } from "@capacitor/haptics";

const BackgroundGeolocation = registerPlugin("BackgroundGeolocation");

const STORAGE_GPS_CFG = "escaner_fiorino_gps_cfg_v1";
const CANAL_ALERTAS = "ruta_alertas_v1";

let watcherId = null;
let notifSeq = 100;
let canalListo = false;

const estadoAlertas = new Map();
let cfg = cargarConfigGPS();

function cargarConfigGPS() {
    try {
        const raw = localStorage.getItem(STORAGE_GPS_CFG);
        if (raw) {
            const p = JSON.parse(raw);
            return {
                radioAviso: Number(p.radioAviso) || 80,
                radioCaminando: Number(p.radioCaminando) || 85,
                minCaminando: Number(p.minCaminando) || 3,
                minutosReaviso: (p.minutosReaviso !== undefined && p.minutosReaviso !== null) ? Number(p.minutosReaviso) : 3,
                avisarNormales: Boolean(p.avisarNormales)
            };
        }
    } catch (e) {}
    return {
        radioAviso: 80,
        radioCaminando: 85,
        minCaminando: 3,
        minutosReaviso: 3,
        avisarNormales: false
    };
}

function guardarConfigGPS() {
    try {
        localStorage.setItem(STORAGE_GPS_CFG, JSON.stringify(cfg));
    } catch (e) {}
}

function esNativo() {
    try {
        return Capacitor.isNativePlatform();
    } catch (e) {
        return false;
    }
}

function nextNotifId() {
    notifSeq = (notifSeq % 900000) + 100;
    return notifSeq;
}

async function asegurarCanalNotificaciones() {
    if (!esNativo() || canalListo) return true;
    try {
        const perm = await LocalNotifications.checkPermissions();
        if (perm.display !== "granted") {
            const req = await LocalNotifications.requestPermissions();
            if (req.display !== "granted") return false;
        }
        await LocalNotifications.createChannel({
            id: CANAL_ALERTAS,
            name: "Alertas de Ruta Fiorino",
            description: "Avisos prioritarios de Va Atrás, Multibulto y Tramo Caminando",
            importance: 5,
            visibility: 1,
            vibration: true
        });
        canalListo = true;
        return true;
    } catch (e) {
        return false;
    }
}

async function hablarNativo(texto, encolar = false) {
    if (!esNativo() || !texto) return;
    try {
        await TextToSpeech.speak({
            text: String(texto),
            lang: "es-ES",
            rate: 1.12,
            pitch: 1.0,
            volume: 1.0,
            category: "playback",
            queueStrategy: encolar ? 1 : 0
        });
    } catch (e) {}
}

async function dispararAlertaNativa({ titulo, cuerpo, voz, urgente = false }) {
    const api = window.FiorinoRuta;
    const modoAudio = api ? api.getModoAudio() : "voz";

    try {
        await asegurarCanalNotificaciones();
        await LocalNotifications.schedule({
            notifications: [{
                id: nextNotifId(),
                channelId: CANAL_ALERTAS,
                title: titulo,
                body: cuerpo
            }]
        });
    } catch (e) {}

    try {
        await Haptics.vibrate({ duration: urgente ? 650 : 350 });
        if (urgente) {
            setTimeout(() => { Haptics.vibrate({ duration: 450 }).catch(() => {}); }, 280);
        }
    } catch (e) {}

    if (modoAudio !== "mudo" && voz) {
        await hablarNativo(voz, true);
    }
}

function uint8ToBase64(bytes) {
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
}

async function guardarYCompartirExcel(wbOut, nombreArchivo) {
    const bytes = wbOut instanceof Uint8Array ? wbOut : new Uint8Array(wbOut);
    const base64 = uint8ToBase64(bytes);

    await Filesystem.writeFile({
        path: nombreArchivo,
        data: base64,
        directory: Directory.Cache
    });

    const uriRes = await Filesystem.getUri({
        directory: Directory.Cache,
        path: nombreArchivo
    });

    try {
        await Share.share({
            title: nombreArchivo,
            text: "Excel limpio para Routin",
            url: uriRes.uri,
            dialogTitle: "Enviar o guardar Excel limpio"
        });
    } catch (e) {
        if (!String(e).toLowerCase().includes("cancel")) throw e;
    }
}

// ---------------- LECTOR DE LINKS GOOGLE MAPS ----------------

function extraerCoordFlexible(texto) {
    const s = String(texto || "")
        .replace(/\\u0026/g, "&")
        .replace(/\\u003d/gi, "=")
        .replace(/\\x26/g, "&")
        .replace(/\\x3d/gi, "=")
        .trim();
    if (!s) return null;

    const m3d = s.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
    if (m3d) {
        const lat = parseFloat(m3d[1]), lon = parseFloat(m3d[2]);
        if (Math.abs(lat) > 1 && Math.abs(lon) > 1) return { lat, lon };
    }

    const mCenter = s.match(/center=(-?\d+\.\d+)(?:%2C|,)\s*(-?\d+\.\d+)/i);
    if (mCenter) {
        const lat = parseFloat(mCenter[1]), lon = parseFloat(mCenter[2]);
        if (Math.abs(lat) > 1 && Math.abs(lon) > 1) return { lat, lon };
    }

    const mNullArr = s.match(/\[null,null,(-?\d+\.\d{4,}),(-?\d+\.\d{4,})\]/);
    if (mNullArr) {
        const lat = parseFloat(mNullArr[1]), lon = parseFloat(mNullArr[2]);
        if (Math.abs(lat) > 1 && Math.abs(lon) > 1) return { lat, lon };
    }

    const mUrl = s.match(/(?:[@?=]|ll=)(-?\d+\.\d+)\s*(?:,|%2C)\s*(-?\d+\.\d+)/i);
    if (mUrl) {
        const lat = parseFloat(mUrl[1]), lon = parseFloat(mUrl[2]);
        if (Math.abs(lat) > 1 && Math.abs(lon) > 1) return { lat, lon };
    }

    const mPlain = s.match(/(-?\d{1,3}[.,]\d{3,})[\s,;]+(-?\d{1,3}[.,]\d{3,})/);
    if (mPlain) {
        const lat = parseFloat(mPlain[1].replace(",", "."));
        const lon = parseFloat(mPlain[2].replace(",", "."));
        if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) > 1 && Math.abs(lon) > 1) {
            return { lat, lon };
        }
    }

    return null;
}

async function resolverCoordDeTextoOShortLink(texto) {
    const directo = extraerCoordFlexible(texto);
    if (directo) return directo;

    const mLink = String(texto || "").match(/https?:\/\/[^\s]+/i);
    if (!mLink || !esNativo()) return null;

    let actualUrl = mLink[0];
    try {
        for (let hop = 0; hop < 4; hop++) {
            const resHop = await CapacitorHttp.get({
                url: actualUrl,
                disableRedirects: true,
                responseType: "text",
                headers: { "User-Agent": "curl/8.4.0" }
            });

            if (resHop.url) {
                const cUrl = extraerCoordFlexible(resHop.url);
                if (cUrl) return cUrl;
            }

            const loc = resHop.headers?.Location || resHop.headers?.location || "";
            if (loc) {
                const cLoc = extraerCoordFlexible(loc);
                if (cLoc) return cLoc;
                actualUrl = loc.startsWith("http") ? loc : new URL(loc, actualUrl).href;
                continue;
            }

            const body = typeof resHop.data === "string" ? resHop.data : JSON.stringify(resHop.data || "");
            const cBody = extraerCoordFlexible(body);
            if (cBody) return cBody;
            break;
        }

        const resFull = await CapacitorHttp.get({
            url: actualUrl,
            responseType: "text",
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" }
        });
        if (resFull.url) {
            const cU = extraerCoordFlexible(resFull.url);
            if (cU) return cU;
        }
        const fullBody = typeof resFull.data === "string" ? resFull.data : JSON.stringify(resFull.data || "");
        return extraerCoordFlexible(fullBody);
    } catch (e) {
        return null;
    }
}

// ---------------- SELECTOR VISUAL EN MAPA (LEAFLET) ----------------

let leafletMap = null;
let leafletMarkerElegido = null;
let puntoMapaElegido = null;
let callbackConfirmarMapa = null;
let capaCalles = null;
let capaSatelite = null;
let usandoSatelite = false;

function asegurarModalMapa() {
    if (document.getElementById("modalMapaSelector")) return;

    const modal = document.createElement("div");
    modal.id = "modalMapaSelector";
    modal.style.cssText = "display:none; position:fixed; inset:0; z-index:10000; background:#0b0f17; flex-direction:column;";
    modal.innerHTML = `
        <div style="padding:10px 12px; background:#1b1f27; border-bottom:1px solid #303746; display:flex; justify-content:space-between; align-items:center; gap:8px;">
            <div style="min-width:0; flex:1;">
                <div style="font-size:0.86rem; font-weight:800; color:#f3f4f6;">🗺️ Toca el mapa para fijar el pin</div>
                <div id="mapaSelectorTitulo" style="font-size:0.74rem; color:#fde047; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;"></div>
            </div>
            <button id="btnToggleSatelite" type="button" class="btn-icon">🛰️ Satélite</button>
            <button id="btnCerrarMapa" type="button" class="btn-icon">✖</button>
        </div>
        <div style="padding:6px 12px; background:#111827; font-size:0.73rem; color:#cbd5e1; display:flex; gap:10px; flex-wrap:wrap; border-bottom:1px solid #1f2937;">
            <span>🔴 Shopee actual</span>
            <span>🟢 Sugerencia</span>
            <span>🔵 Tu pin elegido</span>
        </div>
        <div id="leafletMapBox" style="flex:1; width:100%; min-height:200px;"></div>
        <div style="padding:10px 12px; background:#1b1f27; border-top:1px solid #303746; display:flex; justify-content:space-between; align-items:center; gap:8px;">
            <div id="mapaCoordLive" style="font-size:0.78rem; font-family:monospace; color:#93c5fd;">Toca en el mapa...</div>
            <button id="btnConfirmarPinMapa" type="button" style="background:#15803d; color:#fff; border:1px solid #22c55e; border-radius:8px; padding:9px 14px; font-weight:800; font-size:0.86rem; cursor:pointer;">
                ✅ Usar este pin
            </button>
        </div>
    `;
    document.body.appendChild(modal);

    document.getElementById("btnCerrarMapa").addEventListener("click", () => {
        modal.style.display = "none";
    });

    document.getElementById("btnToggleSatelite").addEventListener("click", () => {
        if (!leafletMap || !capaCalles || !capaSatelite) return;
        const btn = document.getElementById("btnToggleSatelite");
        if (usandoSatelite) {
            leafletMap.removeLayer(capaSatelite);
            capaCalles.addTo(leafletMap);
            usandoSatelite = false;
            btn.innerText = "🛰️ Satélite";
            btn.classList.remove("activo");
        } else {
            leafletMap.removeLayer(capaCalles);
            capaSatelite.addTo(leafletMap);
            usandoSatelite = true;
            btn.innerText = "🗺️ Calles";
            btn.classList.add("activo");
        }
    });

    document.getElementById("btnConfirmarPinMapa").addEventListener("click", () => {
        if (!puntoMapaElegido || !callbackConfirmarMapa) {
            alert("Toca primero en el mapa el lugar exacto de la casa.");
            return;
        }
        const cb = callbackConfirmarMapa;
        const p = puntoMapaElegido;
        modal.style.display = "none";
        cb(Number(p.lat.toFixed(6)), Number(p.lon.toFixed(6)));
    });
}

function abrirSelectorMapa({ lat, lon, sugLat, sugLon, manualLat, manualLon, titulo, centroDefecto, onConfirmar }) {
    if (typeof window.L === "undefined") {
        alert("La librería de mapa no está cargada.");
        return;
    }

    asegurarModalMapa();
    const modal = document.getElementById("modalMapaSelector");
    document.getElementById("mapaSelectorTitulo").innerText = titulo || "";
    callbackConfirmarMapa = onConfirmar;
    modal.style.display = "flex";

    const cLat = manualLat ?? sugLat ?? lat ?? centroDefecto?.lat ?? -22.7539;
    const cLon = manualLon ?? sugLon ?? lon ?? centroDefecto?.lon ?? -47.4136;

    if (leafletMap) {
        leafletMap.remove();
        leafletMap = null;
    }

    leafletMap = window.L.map("leafletMapBox", { zoomControl: true }).setView([cLat, cLon], 17);

    capaCalles = window.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 });
    capaSatelite = window.L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", { maxZoom: 19 });

    if (usandoSatelite) capaSatelite.addTo(leafletMap);
    else capaCalles.addTo(leafletMap);

    if (lat !== null && lon !== null) {
        window.L.circleMarker([lat, lon], { radius: 9, color: "#fff", weight: 2, fillColor: "#ef4444", fillOpacity: 0.9 }).addTo(leafletMap);
    }
    if (sugLat !== null && sugLon !== null) {
        window.L.circleMarker([sugLat, sugLon], { radius: 9, color: "#fff", weight: 2, fillColor: "#22c55e", fillOpacity: 0.9 }).addTo(leafletMap);
    }

    const iconAzul = window.L.divIcon({
        className: "",
        html: `<div style="width:24px;height:24px;border-radius:50%;background:#2563eb;border:3px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,0.6);"></div>`,
        iconSize: [24, 24],
        iconAnchor: [12, 12]
    });

    const ponerPinAzul = (pLat, pLon) => {
        puntoMapaElegido = { lat: pLat, lon: pLon };
        document.getElementById("mapaCoordLive").innerText = `${pLat.toFixed(6)}, ${pLon.toFixed(6)}`;
        if (leafletMarkerElegido) {
            leafletMarkerElegido.setLatLng([pLat, pLon]);
        } else {
            leafletMarkerElegido = window.L.marker([pLat, pLon], { icon: iconAzul, draggable: true }).addTo(leafletMap);
            leafletMarkerElegido.on("dragend", () => {
                const pos = leafletMarkerElegido.getLatLng();
                puntoMapaElegido = { lat: pos.lat, lon: pos.lng };
                document.getElementById("mapaCoordLive").innerText = `${pos.lat.toFixed(6)}, ${pos.lng.toFixed(6)}`;
            });
        }
    };

    leafletMarkerElegido = null;
    puntoMapaElegido = null;
    const initLat = manualLat ?? sugLat;
    const initLon = manualLon ?? sugLon;
    if (initLat !== null && initLon !== null) {
        ponerPinAzul(initLat, initLon);
    }

    leafletMap.on("click", (ev) => {
        ponerPinAzul(ev.latlng.lat, ev.latlng.lng);
    });

    setTimeout(() => { if (leafletMap) leafletMap.invalidateSize(); }, 150);
}

// ---------------- MOTOR GPS EN RUTA ----------------

function construirParadasFisicasOrdenadas() {
    const api = window.FiorinoRuta;
    if (!api) return [];
    const mapaRuta = api.getRuta();
    const mapaGrupos = api.getGrupos();
    const setAtras = api.getAtras();
    if (!mapaRuta || mapaRuta.size === 0 || !mapaGrupos || mapaGrupos.size === 0) return [];

    const lista = [];
    for (const [grupoId, grp] of mapaGrupos.entries()) {
        const paquetes = grp.codigos.map(c => ({ codigo: c, d: mapaRuta.get(c) })).filter(x => x.d);
        if (paquetes.length === 0) continue;

        const paradasUnicas = Array.from(new Set(paquetes.map(p => p.d.parada))).sort((a, b) => a - b);
        const primeraParada = paradasUnicas[0];
        const maxParada = paradasUnicas[paradasUnicas.length - 1];
        const paradasTexto = paradasUnicas.length === 1 ? `${primeraParada}` : `${primeraParada} a ${maxParada}`;

        let cantAtras = 0;
        let lat = null, lon = null, gpsConfiable = false;

        for (const p of paquetes) {
            if (setAtras.has(p.codigo)) cantAtras++;
            if (!gpsConfiable && p.d.lat !== null && p.d.lon !== null && !p.d.esPinSospechoso) {
                lat = p.d.lat;
                lon = p.d.lon;
                gpsConfiable = true;
            }
        }

        const dirBase = paquetes[0].d.dirCompleta || paquetes[0].d.dirPDF || "";
        const dirCorta = dirBase.split(",").slice(0, 2).join(", ").trim();

        lista.push({
            grupoId,
            paradasTexto,
            primeraParada,
            maxParada,
            totalBultos: paquetes.length,
            cantAtras,
            dirCorta,
            lat,
            lon,
            gpsConfiable
        });
    }

    lista.sort((a, b) => a.primeraParada - b.primeraParada);
    return lista;
}

function evaluarDisparoAntiSpam(clave, distActual, radioDisparo) {
    const ahora = Date.now();
    const radioSalida = radioDisparo + 20;
    const prev = estadoAlertas.get(clave);

    if (!prev) {
        if (distActual <= radioDisparo) {
            estadoAlertas.set(clave, { avisos: 1, ts: ahora, salio: false });
            return { disparar: true, esRepetida: false };
        }
        return { disparar: false, esRepetida: false };
    }

    if (distActual > radioSalida) prev.salio = true;
    if (cfg.minutosReaviso <= 0 || prev.avisos >= 3) return { disparar: false, esRepetida: false };

    const msEspera = cfg.minutosReaviso * 60 * 1000;
    if (prev.salio && (ahora - prev.ts) >= msEspera && distActual <= radioDisparo) {
        prev.avisos += 1;
        prev.ts = ahora;
        prev.salio = false;
        return { disparar: true, esRepetida: true };
    }
    return { disparar: false, esRepetida: false };
}

function evaluarUbicacionRuta(location) {
    const api = window.FiorinoRuta;
    if (!api || !location) return;

    const lat = location.latitude;
    const lon = location.longitude;
    const acc = Number(location.accuracy || 0);

    if (acc > 65) {
        actualizarEstadoRutaUI(`🛰️ Señal débil (±${Math.round(acc)}m), esperando GPS preciso...`);
        return;
    }

    const paradas = construirParadasFisicasOrdenadas();
    if (paradas.length === 0) return;

    let minDist = Infinity;
    let paradaMasCercana = null;

    // 1. Tramo caminando
    for (let i = 0; i < paradas.length; i++) {
        const ancla = paradas[i];
        if (!ancla.gpsConfiable) continue;

        const dAncla = api.distanciaMetros(lat, lon, ancla.lat, ancla.lon);
        const cluster = [ancla];
        let prev = ancla;

        for (let j = i + 1; j < paradas.length; j++) {
            const sig = paradas[j];
            if (!sig.gpsConfiable || sig.primeraParada > prev.maxParada + 1) break;
            if (api.distanciaMetros(ancla.lat, ancla.lon, sig.lat, sig.lon) <= cfg.radioCaminando) {
                cluster.push(sig);
                prev = sig;
            } else break;
        }

        if (cluster.length >= cfg.minCaminando) {
            const ult = cluster[cluster.length - 1];
            const walkKey = `walk_${ancla.primeraParada}_${ult.maxParada}`;
            const resWalk = evaluarDisparoAntiSpam(walkKey, dAncla, cfg.radioAviso + 35);
            if (resWalk.disparar) {
                const totalPaq = cluster.reduce((s, g) => s + g.totalBultos, 0);
                const rango = `${ancla.primeraParada} a ${ult.maxParada}`;
                dispararAlertaNativa({
                    titulo: `${resWalk.esRepetida ? "🔁 REPETIDA: " : ""}🚶 TRAMO CAMINANDO: #${rango}`,
                    cuerpo: `${cluster.length} paradas seguidas en ≤${cfg.radioCaminando}m • ${totalPaq} paquetes`,
                    voz: `Tramo caminando: ${cluster.length} paradas cerca, de la ${ancla.primeraParada} a la ${ult.maxParada}. Total ${totalPaq} paquetes.`,
                    urgente: true
                });
            }
        }
    }

    // 2. Paradas individuales (Voz SOLO para Va Atrás y Multibulto)
    for (const g of paradas) {
        if (!g.gpsConfiable) continue;

        const dist = api.distanciaMetros(lat, lon, g.lat, g.lon);
        if (dist < minDist) {
            minDist = dist;
            paradaMasCercana = g;
        }

        const esAtras = g.cantAtras > 0;
        const esMulti = g.totalBultos > 1;
        if (!esAtras && !esMulti && !cfg.avisarNormales) continue;

        const resStop = evaluarDisparoAntiSpam(`stop_${g.grupoId}`, dist, cfg.radioAviso);
        if (!resStop.disparar) continue;

        const prefTitulo = resStop.esRepetida ? "🔁 REPETIDA: " : "";
        const prefVoz = resStop.esRepetida ? "Alerta repetida. " : "";

        let textoVoz = "";
        let tituloNotif = "";
        let cuerpoNotif = `📍 ${g.dirCorta}`;

        if (esAtras) {
            if (esMulti) {
                textoVoz = `${prefVoz}¡Atención! Parada ${g.paradasTexto}, son ${g.totalBultos} bultos y ${g.cantAtras} van atrás.`;
                tituloNotif = `${prefTitulo}🚚 PARADA #${g.paradasTexto} — ${g.totalBultos} BULTOS (${g.cantAtras} ATRÁS)`;
                cuerpoNotif = `📦 ${g.totalBultos} bultos, ${g.cantAtras} atrás • ${g.dirCorta}`;
            } else {
                textoVoz = `${prefVoz}¡Atención! Parada ${g.paradasTexto}, paquete grande atrás.`;
                tituloNotif = `${prefTitulo}🚚 ¡ATENCIÓN! PARADA #${g.paradasTexto} — VA ATRÁS`;
            }
        } else if (esMulti) {
            textoVoz = `${prefVoz}Parada ${g.paradasTexto}, son ${g.totalBultos} bultos.`;
            tituloNotif = `${prefTitulo}📦 PARADA #${g.paradasTexto} — ${g.totalBultos} BULTOS`;
        } else {
            tituloNotif = `${prefTitulo}📍 PARADA #${g.paradasTexto}`;
        }

        dispararAlertaNativa({
            titulo: tituloNotif,
            cuerpo: cuerpoNotif,
            voz: textoVoz,
            urgente: esAtras
        });
    }

    const hora = new Date().toTimeString().slice(0, 5);
    const proxTxt = paradaMasCercana ? ` • Próx: #${paradaMasCercana.paradasTexto} a ${Math.round(minDist)}m` : "";
    actualizarEstadoRutaUI(`🟢 GPS en ruta (${hora}, ±${Math.round(acc)}m)${proxTxt}`);
}

async function toggleSeguimientoRuta() {
    if (!esNativo()) return;
    if (watcherId !== null) {
        try { await BackgroundGeolocation.removeWatcher({ id: watcherId }); } catch (e) {}
        watcherId = null;
        actualizarBotonRutaUI(false);
        actualizarEstadoRutaUI("GPS detenido (sin consumo de batería).");
        return;
    }

    const api = window.FiorinoRuta;
    if (!api || api.getRuta().size === 0) {
        alert("Primero carga el PDF de Routin.");
        return;
    }

    await asegurarCanalNotificaciones();

    try {
        actualizarEstadoRutaUI("🛰️ Iniciando servicio GPS en segundo plano...");
        watcherId = await BackgroundGeolocation.addWatcher(
            {
                backgroundTitle: "Fiorino Pro — En Ruta",
                backgroundMessage: "Vigilando paradas Va Atrás, Multibulto y Tramo Caminando",
                requestPermissions: true,
                stale: false,
                distanceFilter: 8
            },
            (location, error) => {
                if (error) {
                    actualizarEstadoRutaUI(`⚠️ GPS: ${error.message || error.code}`);
                    return;
                }
                evaluarUbicacionRuta(location);
            }
        );
        actualizarBotonRutaUI(true);
    } catch (err) {
        watcherId = null;
        actualizarBotonRutaUI(false);
        actualizarEstadoRutaUI("❌ Error GPS: " + (err.message || err));
    }
}

function actualizarBotonRutaUI(activo) {
    const btn = document.getElementById("btnToggleGpsRuta");
    if (!btn) return;
    btn.innerText = activo ? "⏹️ Detener GPS en Ruta" : "🛰️ Iniciar GPS en Ruta";
    btn.style.background = activo ? "#b91c1c" : "#15803d";
    btn.style.borderColor = activo ? "#ef4444" : "#22c55e";
}

function actualizarEstadoRutaUI(texto) {
    const el = document.getElementById("estadoGpsRuta");
    if (el) el.innerText = texto;
}

function iniciarUI() {
    if (!esNativo()) return;
    const progresoBox = document.querySelector(".progreso-box");
    if (!progresoBox || document.getElementById("panelRutaGps")) return;

    const panel = document.createElement("div");
    panel.id = "panelRutaGps";
    panel.className = "panel";
    panel.style.padding = "10px 12px";
    panel.innerHTML = `
        <button id="btnToggleGpsRuta" type="button" style="width:100%; padding:11px; border-radius:9px; border:1px solid #22c55e; background:#15803d; color:#fff; font-weight:800; font-size:0.95rem; cursor:pointer;">
            🛰️ Iniciar GPS en Ruta
        </button>
        <div id="estadoGpsRuta" style="font-size:0.78rem; color:#9ca3af; margin-top:6px; text-align:center;">
            GPS apagado (actívalo al salir del depósito).
        </div>
        <details style="margin-top:8px; border-top:1px solid #303746; padding-top:7px;">
            <summary style="font-size:0.79rem; font-weight:700; color:#cbd5e1; cursor:pointer;">
                ⚙️ Configurar radios y probar alertas
            </summary>
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-top:8px; font-size:0.78rem;">
                <div>
                    <label style="display:block; color:#9ca3af; margin-bottom:3px;">Radio parada (m)</label>
                    <input type="number" id="cfgRadioAviso" min="30" max="250" step="5" value="${cfg.radioAviso}" style="padding:6px 8px; font-size:0.84rem;">
                </div>
                <div>
                    <label style="display:block; color:#9ca3af; margin-bottom:3px;">Radio caminando (m)</label>
                    <input type="number" id="cfgRadioCaminando" min="30" max="200" step="5" value="${cfg.radioCaminando}" style="padding:6px 8px; font-size:0.84rem;">
                </div>
                <div>
                    <label style="display:block; color:#9ca3af; margin-bottom:3px;">Mín. paradas caminando</label>
                    <input type="number" id="cfgMinCaminando" min="2" max="8" step="1" value="${cfg.minCaminando}" style="padding:6px 8px; font-size:0.84rem;">
                </div>
                <div>
                    <label style="display:block; color:#9ca3af; margin-bottom:3px;">Repetir si vuelvo (min)</label>
                    <input type="number" id="cfgMinutosReaviso" min="0" max="30" step="1" value="${cfg.minutosReaviso}" style="padding:6px 8px; font-size:0.84rem;">
                </div>
            </div>
            <div style="display:flex; gap:6px; margin-top:9px;">
                <button id="btnProbarAlerta" type="button" class="btn-icon" style="flex:1;">🧪 Probar Voz/Notif</button>
                <button id="btnResetAlertas" type="button" class="btn-icon" style="flex:1;">🔄 Re-armar avisos</button>
            </div>
        </details>
    `;

    progresoBox.insertAdjacentElement("afterend", panel);

    document.getElementById("btnToggleGpsRuta").addEventListener("click", toggleSeguimientoRuta);

    const leerInputs = () => {
        cfg.radioAviso = Math.max(30, Number(document.getElementById("cfgRadioAviso").value) || 80);
        cfg.radioCaminando = Math.max(30, Number(document.getElementById("cfgRadioCaminando").value) || 85);
        cfg.minCaminando = Math.max(2, Number(document.getElementById("cfgMinCaminando").value) || 3);
        const rawMin = Number(document.getElementById("cfgMinutosReaviso").value);
        cfg.minutosReaviso = Number.isFinite(rawMin) && rawMin >= 0 ? rawMin : 3;
        guardarConfigGPS();
    };
    ["cfgRadioAviso", "cfgRadioCaminando", "cfgMinCaminando", "cfgMinutosReaviso"].forEach(id => {
        document.getElementById(id).addEventListener("change", leerInputs);
    });

    document.getElementById("btnProbarAlerta").addEventListener("click", () => {
        dispararAlertaNativa({
            titulo: "🚚 PARADA #18 — VA ATRÁS",
            cuerpo: "Rua do Feijão, 350",
            voz: "¡Atención! Parada 18, paquete grande atrás.",
            urgente: true
        });
    });

    document.getElementById("btnResetAlertas").addEventListener("click", () => {
        estadoAlertas.clear();
        actualizarEstadoRutaUI("🔄 Avisos GPS reiniciados.");
    });
}

window.CapBridge = {
    esNativo,
    hablarNativo,
    guardarYCompartirExcel,
    resolverCoordDeTextoOShortLink,
    abrirSelectorMapa,
    iniciarUI
};