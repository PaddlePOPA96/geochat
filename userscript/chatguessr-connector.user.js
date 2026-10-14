// ==UserScript==
// @name         ChatGuessr YouTube - GeoGuessr Auto Connector, Overlay & Viewer Pins
// @namespace    http://tampermonkey.net/
// @version      2.3
// @description  Otomatis mengirim data ronde GeoGuessr ke Railway, menampilkan Scoreboard Overlay & PIN tebakan penonton di peta GeoGuessr
// @author       ChatGuessr
// @match        *://*.geoguessr.com/*
// @run-at       document-start
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        unsafeWindow
// @require      https://cdn.socket.io/4.7.5/socket.io.min.js
// ==/UserScript==

(function () {
  'use strict';

  // Server default Railway
  const DEFAULT_SERVER_URL = 'https://geochat-production-f099.up.railway.app';
  let serverUrl = DEFAULT_SERVER_URL;
  try {
    const saved =
      typeof GM_getValue !== 'undefined'
        ? GM_getValue('cg_server_url')
        : localStorage.getItem('cg_server_url');
    if (saved && !saved.includes('localhost')) {
      serverUrl = saved;
    } else {
      if (typeof GM_setValue !== 'undefined') GM_setValue('cg_server_url', DEFAULT_SERVER_URL);
      localStorage.setItem('cg_server_url', DEFAULT_SERVER_URL);
    }
  } catch (_) {}

  console.log('[ChatGuessr Connector] Started with Server:', serverUrl);

  const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

  // ==========================================
  // 1. GOOGLE MAPS HOOK & OVERLAYVIEW (FOR VIEWER PINS)
  // ==========================================
  let globalMap = null;
  let guessMarkers = [];
  let polylines = [];
  let currentInfoWindow = null;
  let lastRoundResults = null;
  let lastRoundLocation = null;
  let showPinsEnabled = true;
  let CustomMarkerOverlay = null;

  function initOverlayViewClass() {
    if (CustomMarkerOverlay || !win.google?.maps?.OverlayView) return CustomMarkerOverlay;

    CustomMarkerOverlay = class extends win.google.maps.OverlayView {
      constructor(latLng, content, map) {
        super();
        this.latLng =
          latLng instanceof win.google.maps.LatLng
            ? latLng
            : new win.google.maps.LatLng(latLng.lat, latLng.lng);
        this.content = content;
        this.setMap(map);
      }

      onAdd() {
        const panes = this.getPanes();
        if (panes && panes.overlayMouseTarget) {
          panes.overlayMouseTarget.appendChild(this.content);
        }
      }

      draw() {
        const projection = this.getProjection();
        if (!projection || !this.content) return;
        const point = projection.fromLatLngToDivPixel(this.latLng);
        if (point) {
          this.content.style.position = 'absolute';
          this.content.style.left = `${Math.round(point.x)}px`;
          this.content.style.top = `${Math.round(point.y)}px`;
          this.content.style.transform = 'translate(-50%, -100%)';
          this.content.style.pointerEvents = 'auto';
        }
      }

      onRemove() {
        if (this.content && this.content.parentNode) {
          this.content.parentNode.removeChild(this.content);
        }
      }
    };

    return CustomMarkerOverlay;
  }

  function isResultScreenActive() {
    return Boolean(
      document.querySelector('[data-qa="close-round-result"]') ||
      document.querySelector('[data-qa="play-again-button"]') ||
      document.querySelector('[data-qa="round-result"]') ||
      document.querySelector('[class*="round-result"]') ||
      document.querySelector('[class*="result-layout"]')
    );
  }

  function onMapReady(map) {
    if (!map) return;
    const isNewMap = map !== globalMap;
    globalMap = map;
    console.log('[ChatGuessr] Map instance hooked:', map, 'isNewMap:', isNewMap);

    if (
      showPinsEnabled &&
      lastRoundResults &&
      lastRoundResults.length > 0 &&
      (isNewMap || guessMarkers.length === 0)
    ) {
      setTimeout(() => {
        drawViewerPins(lastRoundResults, lastRoundLocation);
      }, 150);
    }
  }

  function hookGoogleMaps() {
    const g = win.google;
    if (g && g.maps && g.maps.Map) {
      if (g.maps.__cg_hooked) return;
      g.maps.__cg_hooked = true;

      const OriginalMap = g.maps.Map;
      g.maps.Map = class extends OriginalMap {
        constructor(mapDiv, opts) {
          super(mapDiv, opts);
          onMapReady(this);
          this.addListener('idle', () => {
            onMapReady(this);
          });
        }
      };
      g.maps.Map.prototype = OriginalMap.prototype;
      console.log('[ChatGuessr] Google Maps successfully hooked for Viewer Pins!');
    } else {
      setTimeout(hookGoogleMaps, 300);
    }
  }

  hookGoogleMaps();

  function drawViewerPins(results, targetLocation) {
    if (!globalMap || !results || results.length === 0 || !showPinsEnabled) {
      return;
    }

    clearViewerPins();

    const OverlayClass = initOverlayViewClass();
    const lineSymbol = {
      path: 'M 0,-1 0,1',
      strokeOpacity: 1,
      scale: 2
    };

    results.forEach((p, idx) => {
      if (!p.position || typeof p.position.lat !== 'number' || typeof p.position.lng !== 'number') return;
      const rank = idx + 1;
      const markerContent = createCustomMarkerElement(p, rank);

      let marker = null;
      if (OverlayClass) {
        try {
          marker = new OverlayClass(p.position, markerContent, globalMap);
        } catch (err) {
          console.warn('[ChatGuessr] CustomMarkerOverlay failed, falling back:', err);
        }
      }

      // Fallback
      if (!marker && win.google?.maps?.Marker) {
        marker = new win.google.maps.Marker({
          map: globalMap,
          position: p.position,
          title: `${p.username} (${p.score} pts)`
        });
      }

      if (marker) guessMarkers.push(marker);

      // Tooltip Mouseover
      markerContent.addEventListener('mouseenter', () => {
        if (currentInfoWindow && globalMap) {
          currentInfoWindow.setContent(`
            <div style="color: #0f172a; font-family: -apple-system, sans-serif; font-size: 12px; padding: 4px;">
              <strong style="font-size: 13px;">${escapeHtml(p.username)}</strong><br/>
              <span style="color: #0284c7; font-weight: bold;">${p.score?.toLocaleString()} pts</span> 
              <span style="color: #64748b;">(${p.distance} km)</span>
            </div>
          `);
          currentInfoWindow.setPosition(p.position);
          currentInfoWindow.open(globalMap);
        }
      });
      markerContent.addEventListener('mouseleave', () => {
        if (currentInfoWindow) currentInfoWindow.close();
      });

      // Garis putus-putus ke jawaban benar
      if (targetLocation && typeof targetLocation.lat === 'number' && win.google?.maps?.Polyline) {
        try {
          const line = new win.google.maps.Polyline({
            path: [p.position, targetLocation],
            map: globalMap,
            strokeOpacity: 0,
            icons: [
              {
                icon: lineSymbol,
                offset: '0',
                repeat: '8px'
              }
            ],
            strokeColor: rank === 1 ? '#f59e0b' : '#38bdf8',
            geodesic: true
          });
          polylines.push(line);
        } catch (_) {}
      }
    });

    console.log(`[ChatGuessr] Placed ${guessMarkers.length} viewer pins on map!`);
  }

  function clearViewerPins() {
    for (const marker of guessMarkers) {
      if (marker.setMap) {
        marker.setMap(null);
      } else if (marker.map !== undefined) {
        marker.map = null;
      }
    }
    guessMarkers = [];
    for (const line of polylines) {
      if (line.setMap) line.setMap(null);
    }
    polylines = [];
    if (currentInfoWindow) currentInfoWindow.close();
  }

  function createCustomMarkerElement(p, rank) {
    const el = document.createElement('div');
    el.className = 'cg-viewer-pin';
    el.style.cssText = `
      position: relative;
      cursor: pointer;
      display: flex;
      flex-direction: column;
      align-items: center;
      transition: transform 0.2s cubic-bezier(0.175, 0.885, 0.32, 1.275);
      z-index: ${1000 - rank};
    `;

    const borderColor =
      rank === 1 ? '#f59e0b' : rank === 2 ? '#94a3b8' : rank === 3 ? '#d97706' : '#38bdf8';

    const avatarBox = document.createElement('div');
    avatarBox.style.cssText = `
      width: 32px;
      height: 32px;
      border-radius: 50%;
      border: 3px solid ${borderColor};
      box-shadow: 0 4px 12px rgba(0,0,0,0.5);
      background: #0f172a;
      overflow: hidden;
      display: flex;
      align-items: center;
      justify-content: center;
    `;

    if (p.avatar) {
      const img = document.createElement('img');
      img.src = p.avatar;
      img.style.cssText = 'width: 100%; height: 100%; object-fit: cover;';
      avatarBox.appendChild(img);
    } else {
      const txt = document.createElement('span');
      txt.textContent = (p.username || '?')[0].toUpperCase();
      txt.style.cssText = 'color: #fff; font-size: 13px; font-weight: 800;';
      avatarBox.appendChild(txt);
    }

    const rankBadge = document.createElement('span');
    rankBadge.textContent = rank;
    rankBadge.style.cssText = `
      position: absolute;
      top: -3px;
      right: -3px;
      background: ${rank === 1 ? '#f59e0b' : '#0f172a'};
      color: #fff;
      font-size: 10px;
      font-weight: 800;
      width: 16px;
      height: 16px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      border: 1px solid rgba(255,255,255,0.7);
    `;

    const nameTag = document.createElement('span');
    nameTag.textContent = p.username;
    nameTag.style.cssText = `
      margin-top: 3px;
      background: rgba(15, 23, 42, 0.9);
      color: #fff;
      font-size: 10px;
      font-weight: 600;
      padding: 1px 6px;
      border-radius: 4px;
      border: 1px solid rgba(255,255,255,0.2);
      white-space: nowrap;
      box-shadow: 0 2px 6px rgba(0,0,0,0.4);
    `;

    el.appendChild(avatarBox);
    el.appendChild(rankBadge);
    el.appendChild(nameTag);

    el.onmouseenter = () => {
      el.style.transform = 'scale(1.3) translateY(-4px)';
      el.style.zIndex = '99999';
    };
    el.onmouseleave = () => {
      el.style.transform = 'scale(1) translateY(0)';
      el.style.zIndex = `${1000 - rank}`;
    };

    return el;
  }

  // ==========================================
  // 2. INTERCEPT FETCH & XHR (unsafeWindow)
  // ==========================================
  const originalFetch = win.fetch;
  win.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';

    if (
      url.includes('/api/v3/games/') ||
      url.includes('/api/v3/challenges/') ||
      url.includes('/api/v4/parties/')
    ) {
      try {
        const clone = response.clone();
        clone
          .json()
          .then((gameData) => {
            handleGeoGuessrGameData(gameData);
          })
          .catch(() => {});
      } catch (err) {
        console.error('[ChatGuessr] Error parsing fetch response:', err);
      }
    }

    return response;
  };

  const originalXHROpen = win.XMLHttpRequest.prototype.open;
  win.XMLHttpRequest.prototype.open = function (...args) {
    this.addEventListener('load', function () {
      try {
        const url = args[1] || '';
        if (
          typeof url === 'string' &&
          (url.includes('/api/v3/games/') || url.includes('/api/v3/challenges/'))
        ) {
          const gameData = JSON.parse(this.responseText);
          handleGeoGuessrGameData(gameData);
        }
      } catch (_) {}
    });
    return originalXHROpen.apply(this, args);
  };

  // ==========================================
  // 3. ACTIVE URL WATCHER & POLLING FALLBACK
  // ==========================================
  let activeGameId = '';
  let pollingInterval = null;

  function checkUrlForGame() {
    const match = win.location.pathname.match(/\/(game|challenge)\/([a-zA-Z0-9_-]{16})/);
    if (match) {
      const gameId = match[2];
      if (gameId !== activeGameId) {
        activeGameId = gameId;
        console.log('[ChatGuessr] Detected active game URL:', gameId);
        fetchGameData(gameId);
      }
      if (!pollingInterval) {
        pollingInterval = setInterval(() => {
          if (activeGameId) fetchGameData(activeGameId);
        }, 3000);
      }
    } else {
      activeGameId = '';
      if (pollingInterval) {
        clearInterval(pollingInterval);
        pollingInterval = null;
      }
    }
  }

  function fetchGameData(gameId) {
    const endpoint = `https://www.geoguessr.com/api/v3/games/${gameId}`;
    (win.fetch || fetch)(endpoint, { credentials: 'include' })
      .then((r) => r.json())
      .then((data) => handleGeoGuessrGameData(data))
      .catch(() => {});
  }

  setInterval(checkUrlForGame, 2000);

  // ==========================================
  // 4. OBSERVING RESULT SCREEN & NEXT ROUND
  // ==========================================
  function observeResultScreen() {
    const observer = new MutationObserver(() => {
      // 1. Hook "Play Next Round" button
      const nextBtn = document.querySelector('[data-qa="close-round-result"]');
      if (nextBtn && !nextBtn.__cg_attached) {
        nextBtn.__cg_attached = true;
        nextBtn.addEventListener('click', () => {
          console.log('[ChatGuessr] Streamer clicked Next Round button!');
          clearViewerPins();
          lastRoundResults = null;
          lastRoundLocation = null;
          setTimeout(() => {
            if (lastGameData) handleGeoGuessrGameData(lastGameData);
          }, 350);
        });
      }

      // 2. Hook "Play Again" button (Game end)
      const playAgainBtn = document.querySelector('[data-qa="play-again-button"]');
      if (playAgainBtn && !playAgainBtn.__cg_attached) {
        playAgainBtn.__cg_attached = true;
        playAgainBtn.addEventListener('click', () => {
          console.log('[ChatGuessr] Streamer clicked Play Again button!');
          clearViewerPins();
          lastRoundResults = null;
          lastRoundLocation = null;
        });
      }

      // 3. If we are on result screen and results are available but pins not drawn:
      if (
        isResultScreenActive() &&
        showPinsEnabled &&
        lastRoundResults &&
        lastRoundResults.length > 0 &&
        guessMarkers.length === 0
      ) {
        drawViewerPins(lastRoundResults, lastRoundLocation);
      }
    });

    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  observeResultScreen();

  // ==========================================
  // 5. SEND GAME DATA TO RAILWAY SERVER
  // ==========================================
  let lastGameData = null;
  let lastHandledGuessesCount = 0;
  let lastHandledRound = 0;
  let lastHandledToken = '';

  function handleGeoGuessrGameData(data) {
    if (!data || !data.token || !data.rounds) return;
    lastGameData = data;

    const token = data.token;
    const mapName = data.mapName || 'GeoGuessr';
    const bounds = data.bounds;
    const guessesCount = data.player?.guesses?.length || 0;
    const isGameFinished = data.state === 'finished';

    // Reset when a new game token is loaded
    if (token !== lastHandledToken) {
      lastHandledToken = token;
      lastHandledGuessesCount = 0;
      lastHandledRound = 0;
      clearViewerPins();
      lastRoundResults = null;
      lastRoundLocation = null;
    }

    // A. STREAMER JUST SUBMITTED A GUESS (Round Finished)
    if (guessesCount > lastHandledGuessesCount) {
      const finishedRound = guessesCount;
      const finishedLocation = data.rounds[finishedRound - 1];
      lastHandledGuessesCount = guessesCount;
      lastHandledRound = finishedRound;

      console.log(`[ChatGuessr] Round ${finishedRound} FINISHED! Forwarding results to server...`, {
        token,
        round: finishedRound,
        location: finishedLocation,
        gameFinished: isGameFinished
      });

      sendToServer({
        token,
        mapName,
        round: finishedRound,
        location: finishedLocation ? { lat: finishedLocation.lat, lng: finishedLocation.lng } : null,
        bounds,
        roundFinished: true,
        gameFinished: isGameFinished
      });
      return;
    }

    // B. STREAMER IS CURRENTLY PLAYING IN PANORAMA (Round in Progress)
    if (!isResultScreenActive() && !isGameFinished) {
      const currentRound = guessesCount + 1;
      const currentLoc = data.rounds[currentRound - 1];

      if (currentRound !== lastHandledRound && currentLoc) {
        lastHandledRound = currentRound;
        console.log(`[ChatGuessr] Round ${currentRound} PLAYING! Opening guesses...`, {
          token,
          round: currentRound,
          location: currentLoc
        });

        sendToServer({
          token,
          mapName,
          round: currentRound,
          location: { lat: currentLoc.lat, lng: currentLoc.lng },
          bounds,
          roundFinished: false,
          gameFinished: false
        });
      }
    }
  }

  function sendToServer(payload) {
    const targetUrl = serverUrl.replace(/\/$/, '') + '/api/geoguessr/update';
    (win.fetch || fetch)(targetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
      .then((res) => {
        updateBadgeStatus(res.ok);
      })
      .catch(() => {
        updateBadgeStatus(false);
      });
  }

  // ==========================================
  // 6. IN-GAME SCOREBOARD OVERLAY & SOCKET.IO
  // ==========================================
  let socket = null;
  let currentState = null;
  let isMinimized = false;

  function initSocket() {
    if (typeof io === 'undefined') {
      console.warn('[ChatGuessr] Socket.IO library not yet loaded, retrying...');
      setTimeout(initSocket, 1000);
      return;
    }

    try {
      if (socket) socket.disconnect();
      socket = io(serverUrl, { transports: ['websocket', 'polling'] });

      socket.on('connect', () => {
        console.log('[ChatGuessr] Connected to Socket.IO server at', serverUrl);
        updateBadgeStatus(true);
      });

      socket.on('disconnect', () => {
        console.log('[ChatGuessr] Disconnected from Socket.IO server');
        updateBadgeStatus(false);
      });

      socket.on('state-update', (state) => {
        currentState = state;
        renderNativeOverlay();
      });

      socket.on('round-started', () => {
        // Only clear pins if streamer has actually left the result screen
        if (!isResultScreenActive()) {
          lastRoundResults = null;
          lastRoundLocation = null;
          clearViewerPins();
        }
        renderNativeOverlay();
      });

      socket.on('round-finished', (data) => {
        renderNativeOverlay();
        if (data && data.results) {
          lastRoundResults = data.results;
          lastRoundLocation = data.location;
          drawViewerPins(data.results, data.location);
        }
      });

      socket.on('guess-added', ({ guess, totalGuesses }) => {
        showInGameToast(guess);
        const countEl = document.getElementById('cg-total-guesses');
        if (countEl) countEl.textContent = `${totalGuesses} Guesses`;
      });
    } catch (e) {
      console.error('[ChatGuessr] Socket.IO initialization error:', e);
    }
  }

  function createInGameUI() {
    if (document.getElementById('cg-native-widget')) return;

    // Inject Stylesheet
    const style = document.createElement('style');
    style.id = 'cg-overlay-styles';
    style.textContent = `
      #cg-native-widget {
        position: fixed;
        top: 20px;
        right: 20px;
        width: 330px;
        background: rgba(15, 23, 42, 0.92);
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        border: 1px solid rgba(255, 255, 255, 0.15);
        border-radius: 16px;
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.65);
        color: #fff;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        z-index: 999999;
        overflow: hidden;
        user-select: none;
        transition: all 0.25s ease;
      }
      #cg-native-widget.minimized .cg-content-body {
        display: none !important;
      }
      .cg-header {
        padding: 10px 14px;
        background: linear-gradient(135deg, rgba(239, 68, 68, 0.3), rgba(56, 189, 248, 0.2));
        border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        display: flex;
        align-items: center;
        justify-content: space-between;
        cursor: grab;
      }
      .cg-header-left {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .cg-logo-icon {
        width: 22px;
        height: 22px;
        background: #ef4444;
        border-radius: 5px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 11px;
        font-weight: 800;
      }
      .cg-title {
        font-size: 13px;
        font-weight: 700;
        letter-spacing: -0.2px;
      }
      .cg-round-badge {
        font-size: 11px;
        font-weight: 700;
        background: rgba(255, 255, 255, 0.2);
        padding: 2px 7px;
        border-radius: 10px;
        font-family: monospace;
      }
      .cg-header-actions {
        display: flex;
        align-items: center;
        gap: 4px;
      }
      .cg-btn-icon {
        background: transparent;
        border: none;
        color: #94a3b8;
        font-size: 13px;
        cursor: pointer;
        padding: 2px 6px;
        border-radius: 4px;
      }
      .cg-btn-icon:hover {
        background: rgba(255, 255, 255, 0.15);
        color: #fff;
      }
      .cg-status-row {
        padding: 6px 14px;
        background: rgba(0, 0, 0, 0.35);
        display: flex;
        justify-content: space-between;
        align-items: center;
        font-size: 11px;
        font-weight: 600;
      }
      .cg-status-open {
        color: #10b981;
        display: flex;
        align-items: center;
        gap: 5px;
      }
      .cg-status-closed {
        color: #94a3b8;
        display: flex;
        align-items: center;
        gap: 5px;
      }
      .cg-status-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: currentColor;
      }
      .cg-list {
        max-height: 280px;
        overflow-y: auto;
        padding: 4px 0;
      }
      .cg-player-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 6px 14px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.04);
        font-size: 12px;
        cursor: pointer;
        transition: background 0.15s;
      }
      .cg-player-row:hover {
        background: rgba(255, 255, 255, 0.08);
      }
      .cg-rank-gold { color: #f59e0b; font-weight: 800; }
      .cg-rank-silver { color: #94a3b8; font-weight: 700; }
      .cg-rank-bronze { color: #d97706; font-weight: 700; }
      .cg-empty-text {
        padding: 16px;
        text-align: center;
        font-size: 11px;
        color: #64748b;
      }
      /* Toast notification */
      #cg-toast-box {
        position: fixed;
        bottom: 60px;
        right: 20px;
        display: flex;
        flex-direction: column;
        gap: 8px;
        z-index: 1000000;
        pointer-events: none;
      }
      .cg-toast {
        background: rgba(15, 23, 42, 0.95);
        border: 1px solid rgba(56, 189, 248, 0.4);
        padding: 8px 14px;
        border-radius: 10px;
        box-shadow: 0 4px 16px rgba(0,0,0,0.5);
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 12px;
        animation: cgFadeIn 0.3s ease;
      }
      @keyframes cgFadeIn {
        from { opacity: 0; transform: translateY(10px); }
        to { opacity: 1; transform: translateY(0); }
      }
    `;
    document.head.appendChild(style);

    // Create Widget Container
    const widget = document.createElement('div');
    widget.id = 'cg-native-widget';
    widget.innerHTML = `
      <div class="cg-header" id="cg-drag-handle">
        <div class="cg-header-left">
          <div class="cg-logo-icon">▶</div>
          <span class="cg-title" id="cg-map-title">GeoGuessr Live</span>
          <span class="cg-round-badge" id="cg-round-badge">R1 / 5</span>
        </div>
        <div class="cg-header-actions">
          <button class="cg-btn-icon" id="cg-btn-pins" title="Toggle Tampilkan Pins di Peta">📌</button>
          <button class="cg-btn-icon" id="cg-btn-minimize" title="Minimize">_</button>
          <button class="cg-btn-icon" id="cg-btn-hide" title="Hide Overlay">✕</button>
        </div>
      </div>
      <div class="cg-content-body">
        <div class="cg-status-row">
          <div id="cg-status-box" class="cg-status-closed">
            <span class="cg-status-dot"></span>
            <span id="cg-status-label">Tebakan Ditutup</span>
          </div>
          <div id="cg-total-guesses" style="color: #94a3b8;">0 Guesses</div>
        </div>
        <div class="cg-list" id="cg-players-list">
          <div class="cg-empty-text">Ketik <code>!g [nama_kota]</code> di YouTube chat!</div>
        </div>
      </div>
    `;

    document.body.appendChild(widget);

    // Toast Container
    const toastBox = document.createElement('div');
    toastBox.id = 'cg-toast-box';
    document.body.appendChild(toastBox);

    // Pin Toggle Action
    const pinBtn = document.getElementById('cg-btn-pins');
    pinBtn.onclick = () => {
      showPinsEnabled = !showPinsEnabled;
      pinBtn.style.opacity = showPinsEnabled ? '1' : '0.4';
      if (!showPinsEnabled) {
        clearViewerPins();
      } else if (lastRoundResults && lastRoundResults.length > 0) {
        drawViewerPins(lastRoundResults, lastRoundLocation);
      }
    };

    // Minimize & Hide Actions
    document.getElementById('cg-btn-minimize').onclick = () => {
      isMinimized = !isMinimized;
      widget.classList.toggle('minimized', isMinimized);
      document.getElementById('cg-btn-minimize').textContent = isMinimized ? '□' : '_';
    };

    document.getElementById('cg-btn-hide').onclick = () => {
      widget.style.display = 'none';
      const toggle = document.getElementById('cg-overlay-toggle');
      if (toggle) toggle.textContent = 'Show Overlay';
    };

    // Bottom-Right Status Badge
    createBadgeUI();

    // Enable simple dragging
    enableDrag(widget, document.getElementById('cg-drag-handle'));

    // Connect Socket.IO
    initSocket();
  }

  function renderNativeOverlay() {
    if (!currentState) return;

    const mapTitle = document.getElementById('cg-map-title');
    const roundBadge = document.getElementById('cg-round-badge');
    const statusBox = document.getElementById('cg-status-box');
    const statusLabel = document.getElementById('cg-status-label');
    const totalGuesses = document.getElementById('cg-total-guesses');
    const listContainer = document.getElementById('cg-players-list');

    if (!mapTitle) return;

    mapTitle.textContent = currentState.mapName || 'GeoGuessr Live';
    roundBadge.textContent = `R${currentState.round} / 5`;

    if (currentState.guessesOpen) {
      statusBox.className = 'cg-status-open';
      statusLabel.textContent = 'Tebakan Dibuka';
    } else {
      statusBox.className = 'cg-status-closed';
      statusLabel.textContent = 'Tebakan Ditutup';
    }

    const guesses = currentState.roundGuesses || [];
    totalGuesses.textContent = `${guesses.length} Guesses`;

    if (guesses.length === 0) {
      listContainer.innerHTML =
        '<div class="cg-empty-text">Ketik <code>!g [nama_kota]</code> di YouTube chat!</div>';
      return;
    }

    let html = '';
    guesses.slice(0, 10).forEach((p, idx) => {
      const rank = idx + 1;
      let rankClass = '';
      if (rank === 1) rankClass = 'cg-rank-gold';
      else if (rank === 2) rankClass = 'cg-rank-silver';
      else if (rank === 3) rankClass = 'cg-rank-bronze';

      html += `
        <div class="cg-player-row" data-user-id="${p.userId}" title="Klik untuk fokus pin pemain di peta">
          <div style="display: flex; align-items: center; gap: 8px;">
            <span class="${rankClass}" style="width: 14px; text-align: right;">${rank}</span>
            <span style="font-weight: 600; max-width: 130px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
              ${escapeHtml(p.username)}
            </span>
          </div>
          <div style="text-align: right;">
            <span style="font-weight: 700; color: #38bdf8;">${p.score.toLocaleString()}</span>
            <span style="color: #64748b; font-size: 10px; margin-left: 4px;">${p.distance} km</span>
          </div>
        </div>
      `;
    });

    listContainer.innerHTML = html;

    // Attach click listeners to pan map to player position
    listContainer.querySelectorAll('.cg-player-row').forEach((row, i) => {
      row.onclick = () => {
        const player = guesses[i];
        if (globalMap && player && player.position) {
          globalMap.panTo(player.position);
          globalMap.setZoom(Math.max(globalMap.getZoom() || 6, 8));
          showInGameToast(player);
        }
      };
    });
  }

  function showInGameToast(guess) {
    const box = document.getElementById('cg-toast-box');
    if (!box) return;

    const toast = document.createElement('div');
    toast.className = 'cg-toast';
    toast.innerHTML = `
      <span>🎯</span>
      <div>
        <strong style="color: #fff;">${escapeHtml(guess.username)}</strong>
        <span style="color: #38bdf8; font-family: monospace; margin-left: 6px;">
          ${guess.score} pts (${guess.distance} km)
        </span>
      </div>
    `;

    box.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
  }

  function createBadgeUI() {
    if (document.getElementById('cg-bridge-badge')) return;

    const div = document.createElement('div');
    div.id = 'cg-bridge-badge';
    div.style.position = 'fixed';
    div.style.bottom = '16px';
    div.style.right = '16px';
    div.style.zIndex = '999999';
    div.style.background = 'rgba(15, 23, 42, 0.9)';
    div.style.border = '1px solid rgba(255, 255, 255, 0.2)';
    div.style.borderRadius = '24px';
    div.style.padding = '6px 14px';
    div.style.color = '#fff';
    div.style.fontSize = '12px';
    div.style.display = 'flex';
    div.style.alignItems = 'center';
    div.style.gap = '8px';
    div.style.cursor = 'pointer';
    div.style.boxShadow = '0 4px 12px rgba(0,0,0,0.5)';

    div.innerHTML = `
      <span id="cg-bridge-dot" style="width: 8px; height: 8px; border-radius: 50%; background: #94a3b8;"></span>
      <span id="cg-bridge-text" style="font-weight: 600;">ChatGuessr</span>
      <span id="cg-overlay-toggle" style="background: rgba(255,255,255,0.2); border-radius: 12px; padding: 2px 8px; margin-left: 4px; font-size: 11px;">Hide Overlay</span>
    `;

    div.onclick = (e) => {
      if (e.target && e.target.id === 'cg-overlay-toggle') {
        const widget = document.getElementById('cg-native-widget');
        if (!widget) return;
        if (widget.style.display === 'none') {
          widget.style.display = 'block';
          e.target.textContent = 'Hide Overlay';
        } else {
          widget.style.display = 'none';
          e.target.textContent = 'Show Overlay';
        }
        return;
      }

      const newUrl = prompt('Masukkan URL Server ChatGuessr Railway Anda:', serverUrl);
      if (newUrl && newUrl.trim()) {
        serverUrl = newUrl.trim();
        if (typeof GM_setValue !== 'undefined') GM_setValue('cg_server_url', serverUrl);
        localStorage.setItem('cg_server_url', serverUrl);
        alert('Server URL disimpan: ' + serverUrl);
        initSocket();
      }
    };

    document.body.appendChild(div);
  }

  function updateBadgeStatus(connected) {
    const dot = document.getElementById('cg-bridge-dot');
    const text = document.getElementById('cg-bridge-text');
    if (dot && text) {
      dot.style.background = connected ? '#10b981' : '#ef4444';
      text.textContent = connected ? 'ChatGuessr: Connected' : 'ChatGuessr: Offline';
    }
  }

  function enableDrag(element, handle) {
    let pos1 = 0,
      pos2 = 0,
      pos3 = 0,
      pos4 = 0;
    handle.onmousedown = dragMouseDown;

    function dragMouseDown(e) {
      if (e.target.tagName === 'BUTTON') return;
      e.preventDefault();
      pos3 = e.clientX;
      pos4 = e.clientY;
      document.onmouseup = closeDragElement;
      document.onmousemove = elementDrag;
    }

    function elementDrag(e) {
      e.preventDefault();
      pos1 = pos3 - e.clientX;
      pos2 = pos4 - e.clientY;
      pos3 = e.clientX;
      pos4 = e.clientY;
      element.style.top = element.offsetTop - pos2 + 'px';
      element.style.left = element.offsetLeft - pos1 + 'px';
      element.style.right = 'auto';
    }

    function closeDragElement() {
      document.onmouseup = null;
      document.onmousemove = null;
    }
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Initialize UI when DOM is ready
  const initUI = () => {
    if (!document.body) {
      setTimeout(initUI, 200);
      return;
    }
    createInGameUI();
  };

  if (document.readyState === 'loading') {
    win.addEventListener('DOMContentLoaded', initUI);
  } else {
    initUI();
  }
})();
