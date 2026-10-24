// ==UserScript==
// @name         MabarBang GeoGuessr Connector
// @namespace    https://github.com/PaddlePOPA96/geochat
// @version      3.3.1
// @description  Otomatis mengirim data ronde GeoGuessr ke Server MabarBang, menampilkan Scoreboard Overlay & PIN tebakan penonton di peta GeoGuessr
// @author       kikobooo x arvana prod
// @match        *://*.geoguessr.com/*
// @run-at       document-start
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      localhost
// @connect      127.0.0.1
// @connect      geoindo.my.id
// @require      https://cdn.socket.io/4.7.5/socket.io.min.js
// @updateURL    https://raw.githubusercontent.com/PaddlePOPA96/geochat/main/userscript/chatguessr-connector.user.js
// @downloadURL  https://raw.githubusercontent.com/PaddlePOPA96/geochat/main/userscript/chatguessr-connector.user.js
// ==/UserScript==

(function () {
  'use strict';

  // Server URLs (Cloud Railway vs Local 5050)
  const CLOUD_SERVER_URL = 'https://geoindo.up.railway.app/';
  const LOCAL_SERVER_URL = 'http://localhost:5050';

  let serverUrl = LOCAL_SERVER_URL;
  let streamerId = '';

  try {
    const saved =
      typeof GM_getValue !== 'undefined'
        ? GM_getValue('cg_server_url')
        : localStorage.getItem('cg_server_url');
    if (saved && saved.trim()) {
      serverUrl = saved.trim();
    }
  } catch (_) { }

  try {
    const savedStreamer =
      typeof GM_getValue !== 'undefined'
        ? GM_getValue('cg_streamer_id')
        : localStorage.getItem('cg_streamer_id');
    if (savedStreamer && savedStreamer.trim()) {
      streamerId = savedStreamer.trim();
    }
  } catch (_) { }

  function getServerMode() {
    if (serverUrl.includes('localhost') || serverUrl.includes('127.0.0.1')) {
      return 'local';
    }
    if (serverUrl.includes('railway') || serverUrl === CLOUD_SERVER_URL) {
      return 'cloud';
    }
    return 'custom';
  }

  function setServerUrl(newUrl, modeName) {
    serverUrl = newUrl.trim();
    if (typeof GM_setValue !== 'undefined') GM_setValue('cg_server_url', serverUrl);
    try {
      localStorage.setItem('cg_server_url', serverUrl);
    } catch (_) { }
    updateServerModeUI();
    initSocket();
    showToast(`Server: ${modeName || serverUrl}`);
  }

  function setStreamerId(newId) {
    streamerId = (newId || '').trim();
    if (typeof GM_setValue !== 'undefined') GM_setValue('cg_streamer_id', streamerId);
    try {
      localStorage.setItem('cg_streamer_id', streamerId);
    } catch (_) { }
    initSocket();
    showToast(streamerId ? `Streamer ID: ${streamerId}` : 'Streamer ID di-reset');
  }

  function showToast(msg) {
    try {
      let toast = document.getElementById('cg-toast-msg');
      if (!toast) {
        toast = document.createElement('div');
        toast.id = 'cg-toast-msg';
        toast.style.cssText = `
          position: fixed;
          bottom: 24px;
          right: 24px;
          background: #ffe082;
          color: #000;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          font-weight: 800;
          font-size: 13px;
          padding: 10px 18px;
          border: 2.5px solid #000;
          border-radius: 12px;
          box-shadow: 4px 4px 0px #000;
          z-index: 1000000;
          transition: opacity 0.3s ease, transform 0.3s ease;
          pointer-events: none;
        `;
        document.body.appendChild(toast);
      }
      toast.textContent = typeof msg === 'object' ? (msg.score || msg.username || JSON.stringify(msg)) : msg;
      toast.style.opacity = '1';
      toast.style.transform = 'translateY(0)';
      clearTimeout(toast.__timer);
      toast.__timer = setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(10px)';
      }, 3000);
    } catch (_) { }
  }

  console.log('[MabarBang Connector] Started with Server:', serverUrl);

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
  let latestStreamerGuess = null;
  let showPinsEnabled = true;
  let CustomMarkerOverlay = null;

  function haversineDistance(mk1, mk2) {
    const R = 6371.071;
    const rlat1 = mk1.lat * (Math.PI / 180);
    const rlat2 = mk2.lat * (Math.PI / 180);
    const difflat = rlat2 - rlat1;
    const difflon = (mk2.lng - mk1.lng) * (Math.PI / 180);
    return (
      2 *
      R *
      Math.asin(
        Math.sqrt(
          Math.sin(difflat / 2) ** 2 + Math.cos(rlat1) * Math.cos(rlat2) * Math.sin(difflon / 2) ** 2
        )
      )
    );
  }

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
    console.log('[MabarBang] Map instance hooked:', map, 'isNewMap:', isNewMap);

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
      console.log('[MabarBang] Google Maps successfully hooked for Viewer Pins!');
    } else {
      setTimeout(hookGoogleMaps, 300);
    }
  }

  hookGoogleMaps();

  // Maksimal pin yang dirender di layar peta untuk menjaga FPS browser tetap lancar
  const MAX_MAP_PINS = 1000;

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

    // Ambil maksimal 1.000 pin teratas, dan pastikan pin streamer tetap masuk jika ada
    const displayList = results.slice(0, MAX_MAP_PINS);
    const streamerPin = results.find((p) => p.userId === 'streamer' || p.isStreamer);
    if (streamerPin && !displayList.some((p) => p.userId === 'streamer')) {
      displayList.push(streamerPin);
    }

    displayList.forEach((p, idx) => {
      if (!p.position || typeof p.position.lat !== 'number' || typeof p.position.lng !== 'number') return;
      const rank = p.rank || (idx + 1);
      const markerContent = createCustomMarkerElement(p, rank);

      let marker = null;
      if (OverlayClass) {
        try {
          marker = new OverlayClass(p.position, markerContent, globalMap);
        } catch (err) {
          console.warn('[MabarBang] CustomMarkerOverlay failed, falling back:', err);
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
          const isDonationGuess = p.platform === 'geoindo' || p.platform === 'Tako' || p.isDonation || (p.userId && p.userId.startsWith('geoindo_'));
          const lineStrokeColor = isDonationGuess ? '#10b981' : (rank === 1 ? '#f59e0b' : '#38bdf8');
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
            strokeColor: lineStrokeColor,
            geodesic: true
          });
          polylines.push(line);
        } catch (_) { }
      }
    });

    console.log(`[MabarBang] Placed ${guessMarkers.length} viewer pins on map!`);
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

    const isDonation = p.platform === 'geoindo' || p.platform === 'Tako' || p.isDonation || (p.userId && p.userId.startsWith('geoindo_'));

    const rankColor = isDonation
      ? '#10b981'
      : (rank === 1 ? '#ffd166' : rank === 2 ? '#70d6ff' : rank === 3 ? '#ff9ebb' : '#ffffff');

    const avatarBox = document.createElement('div');
    avatarBox.style.cssText = `
      width: ${isDonation ? '36px' : '34px'};
      height: ${isDonation ? '36px' : '34px'};
      border-radius: 50%;
      border: ${isDonation ? '3px solid #000' : '2.5px solid #000'};
      box-shadow: ${isDonation ? '3px 3px 0px #059669' : '2.5px 2.5px 0px #000'};
      background: ${isDonation ? '#d1fae5' : '#ffffff'};
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
      txt.textContent = isDonation ? '💸' : (p.username || '?')[0].toUpperCase();
      txt.style.cssText = `color: #000; font-size: ${isDonation ? '16px' : '13px'}; font-weight: 900;`;
      avatarBox.appendChild(txt);
    }

    const rankBadge = document.createElement('span');
    rankBadge.textContent = rank;
    rankBadge.style.cssText = `
      position: absolute;
      top: -4px;
      right: -4px;
      background: ${rankColor};
      color: ${isDonation ? '#ffffff' : '#000000'};
      font-size: 10px;
      font-weight: 900;
      width: 18px;
      height: 18px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      border: 2px solid #000;
      box-shadow: 1.5px 1.5px 0px #000;
    `;

    const nameTag = document.createElement('span');
    nameTag.textContent = (isDonation ? '💸 ' : '') + p.username;
    nameTag.style.cssText = `
      margin-top: 4px;
      background: ${isDonation ? '#ecfdf5' : '#ffffff'};
      color: ${isDonation ? '#065f46' : '#000000'};
      font-size: 10px;
      font-weight: 800;
      padding: 2px 8px;
      border-radius: 9999px;
      border: 2px solid ${isDonation ? '#059669' : '#000000'};
      white-space: nowrap;
      box-shadow: 2px 2px 0px #000;
    `;

    el.appendChild(avatarBox);
    el.appendChild(rankBadge);

    // Badge tanda donasi jika tebakan berasal dari donasi GeoIndo
    if (isDonation) {
      const donBadge = document.createElement('span');
      donBadge.textContent = '★';
      donBadge.title = 'Donasi GeoIndo / Tako';
      donBadge.style.cssText = `
        position: absolute;
        top: -4px;
        left: -4px;
        background: #f59e0b;
        color: #ffffff;
        font-size: 11px;
        font-weight: 900;
        width: 18px;
        height: 18px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        border: 2px solid #000;
        box-shadow: 1.5px 1.5px 0px #000;
      `;
      el.appendChild(donBadge);
    }

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
          .catch(() => { });
      } catch (err) {
        console.error('[MabarBang] Error parsing fetch response:', err);
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
      } catch (_) { }
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
        console.log('[MabarBang] Detected active game URL:', gameId);
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
      .catch(() => { });
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
          console.log('[MabarBang] Streamer clicked Next Round button!');
          latestStreamerGuess = null;
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
          console.log('[MabarBang] Streamer clicked Play Again button!');
          latestStreamerGuess = null;
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
      latestStreamerGuess = null;
      clearViewerPins();
      lastRoundResults = null;
      lastRoundLocation = null;
    }

    // A. STREAMER JUST SUBMITTED A GUESS (Round Finished)
    if (guessesCount > lastHandledGuessesCount) {
      const finishedRound = guessesCount;
      const finishedLocation = data.rounds[finishedRound - 1];
      const streamerRawGuess = data.player?.guesses?.[finishedRound - 1];

      // Extract streamer score & distance from GeoGuessr data
      let streamerGuess = null;
      if (streamerRawGuess) {
        const rawScore = typeof streamerRawGuess.roundScoreInPoints === 'number'
          ? streamerRawGuess.roundScoreInPoints
          : (typeof streamerRawGuess.score === 'number' ? streamerRawGuess.score : 0);

        let rawDist = 0;
        if (typeof streamerRawGuess.distanceInMeters === 'number') {
          rawDist = Math.round((streamerRawGuess.distanceInMeters / 1000) * 100) / 100;
        } else if (typeof streamerRawGuess.distance === 'number') {
          rawDist = Math.round(streamerRawGuess.distance * 100) / 100;
        } else if (finishedLocation && typeof streamerRawGuess.lat === 'number' && typeof streamerRawGuess.lng === 'number') {
          rawDist = Math.round(haversineDistance(
            { lat: streamerRawGuess.lat, lng: streamerRawGuess.lng },
            { lat: finishedLocation.lat, lng: finishedLocation.lng }
          ) * 100) / 100;
        }

        // Calculate total streamer score from all rounds so far
        let totalScore = 0;
        let totalDistance = 0;
        if (Array.isArray(data.player?.guesses)) {
          for (const g of data.player.guesses) {
            const sc = typeof g.roundScoreInPoints === 'number' ? g.roundScoreInPoints : (g.score || 0);
            const dst = typeof g.distanceInMeters === 'number' ? (g.distanceInMeters / 1000) : (g.distance || 0);
            totalScore += sc;
            totalDistance += dst;
          }
        }

        streamerGuess = {
          score: rawScore,
          distance: rawDist,
          totalScore,
          totalDistance: Math.round(totalDistance * 100) / 100,
          lat: streamerRawGuess.lat,
          lng: streamerRawGuess.lng
        };

        // Cache locally for immediate widget rendering
        latestStreamerGuess = streamerGuess;
      }

      lastHandledGuessesCount = guessesCount;
      lastHandledRound = finishedRound;

      console.log(`[MabarBang] Round ${finishedRound} FINISHED! Forwarding results with Streamer score to server...`, {
        token,
        round: finishedRound,
        location: finishedLocation,
        streamerGuess,
        gameFinished: isGameFinished
      });

      sendToServer({
        token,
        mapName,
        round: finishedRound,
        location: finishedLocation ? { lat: finishedLocation.lat, lng: finishedLocation.lng } : null,
        bounds,
        streamerGuess,
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
        latestStreamerGuess = null;
        console.log(`[MabarBang] Round ${currentRound} PLAYING! Opening guesses...`, {
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
    const bodyStr = JSON.stringify({
      ...payload,
      streamerId: streamerId || undefined
    });

    if (typeof GM_xmlhttpRequest !== 'undefined') {
      GM_xmlhttpRequest({
        method: 'POST',
        url: targetUrl,
        headers: { 'Content-Type': 'application/json' },
        data: bodyStr,
        onload: (res) => {
          updateBadgeStatus(res.status >= 200 && res.status < 300);
        },
        onerror: () => {
          updateBadgeStatus(false);
        }
      });
      return;
    }

    (win.fetch || fetch)(targetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: bodyStr
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
      console.warn('[MabarBang] Socket.IO library not yet loaded, retrying...');
      setTimeout(initSocket, 1000);
      return;
    }

    try {
      if (socket) socket.disconnect();
      socket = io(serverUrl, { transports: ['websocket', 'polling'] });

      socket.on('connect', () => {
        console.log('[MabarBang] Connected to Socket.IO server at', serverUrl);
        if (streamerId) {
          socket.emit('join-streamer', streamerId, 'In-Game Overlay');
        } else {
          socket.emit('request-state');
        }
        updateBadgeStatus(true);
      });

      socket.on('disconnect', () => {
        console.log('[MabarBang] Disconnected from Socket.IO server');
        updateBadgeStatus(false);
      });

      socket.on('state-update', (state) => {
        // If userscript is tied to a specific streamer ID, filter out updates from other streamers
        if (streamerId && state.streamerId && state.streamerId !== 'default' && state.streamerId !== streamerId) {
          return;
        }
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
      console.error('[MabarBang] Socket.IO initialization error:', e);
    }
  }

  function createInGameUI() {
    if (document.getElementById('cg-native-widget')) return;

    // Inject Stylesheet
    const style = document.createElement('style');
    style.id = 'cg-overlay-styles';
    style.textContent = `
      /* Fullscreen Curtain & Intro Card */
      #cg-intro-curtain {
        position: fixed;
        inset: 0;
        z-index: 9999999;
        display: flex;
        align-items: center;
        justify-content: center;
        overflow: hidden;
        pointer-events: all;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      }
      .cg-curtain-slab {
        position: absolute;
        left: 0;
        width: 100%;
        height: 50.5%;
        z-index: 1;
        transition: transform 0.65s cubic-bezier(0.85, 0, 0.15, 1);
      }
      .cg-curtain-top {
        top: 0;
        background: #ffe082;
        border-bottom: 5px solid #000000;
        background-image: radial-gradient(#000000 1.5px, transparent 1.5px);
        background-size: 24px 24px;
        transform: translateY(0);
      }
      .cg-curtain-bottom {
        bottom: 0;
        background: #c8f560;
        border-top: 5px solid #000000;
        background-image: radial-gradient(#000000 1.5px, transparent 1.5px);
        background-size: 24px 24px;
        transform: translateY(0);
      }
      #cg-intro-curtain.dismissed .cg-curtain-top {
        transform: translateY(-101%);
      }
      #cg-intro-curtain.dismissed .cg-curtain-bottom {
        transform: translateY(101%);
      }
      .cg-intro-card-wrap {
        position: relative;
        z-index: 10;
        padding: 20px;
        transition: transform 0.5s cubic-bezier(0.85, 0, 0.15, 1), opacity 0.4s ease;
      }
      #cg-intro-curtain.dismissed .cg-intro-card-wrap {
        transform: scale(0.3) translate(80vw, -80vh);
        opacity: 0;
        pointer-events: none;
      }
      .cg-intro-card {
        background: #ffffff;
        border: 4px solid #000000;
        border-radius: 28px;
        box-shadow: 10px 10px 0px #000000;
        padding: 34px 28px 26px;
        max-width: 500px;
        width: 90vw;
        text-align: center;
        position: relative;
        animation: cgPopIntro 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
      }
      @keyframes cgPopIntro {
        0% { transform: scale(0.6) rotate(-6deg); opacity: 0; }
        70% { transform: scale(1.04) rotate(1deg); }
        100% { transform: scale(1) rotate(0deg); opacity: 1; }
      }
      .cg-intro-sticker {
        position: absolute;
        font-size: 11px;
        font-weight: 900;
        border: 2px solid #000;
        border-radius: 999px;
        padding: 3px 10px;
        box-shadow: 2.5px 2.5px 0px #000;
        letter-spacing: 0.5px;
      }
      .cg-sticker-tl {
        top: -12px;
        left: 16px;
        background: #70d6ff;
        color: #000;
        transform: rotate(-5deg);
      }
      .cg-sticker-tr {
        top: -12px;
        right: 16px;
        background: #c8f560;
        color: #000;
        transform: rotate(4deg);
      }
      .cg-intro-title {
        font-size: clamp(32px, 6vw, 50px);
        font-weight: 900;
        letter-spacing: -1.5px;
        color: #000000;
        line-height: 1.05;
        margin: 6px 0 12px;
        text-transform: uppercase;
        transform: rotate(-1.5deg);
        text-shadow: 3px 3px 0px #ffe082, 5px 5px 0px #000000;
      }
      .cg-intro-badge {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        background: #ff5964;
        color: #ffffff;
        border: 2.5px solid #000000;
        border-radius: 999px;
        padding: 6px 16px;
        font-weight: 900;
        font-size: 13px;
        box-shadow: 3px 3px 0px #000000;
        margin-bottom: 12px;
      }
      .cg-intro-bar-outer {
        width: 100%;
        max-width: 240px;
        height: 12px;
        background: #f8fafc;
        border: 2px solid #000000;
        border-radius: 999px;
        margin: 0 auto 14px;
        overflow: hidden;
        box-shadow: 2px 2px 0px #000000;
      }
      .cg-intro-bar-inner {
        height: 100%;
        width: 0%;
        background: repeating-linear-gradient(45deg, #c8f560, #c8f560 10px, #bbf7d0 10px, #bbf7d0 20px);
        border-right: 2px solid #000000;
        animation: cgFillProgress 1.5s ease-in-out forwards;
      }
      @keyframes cgFillProgress {
        0% { width: 0%; }
        60% { width: 75%; }
        100% { width: 100%; }
      }
      .cg-intro-btn {
        background: #000000;
        color: #ffffff;
        border: 2.5px solid #000000;
        border-radius: 999px;
        padding: 10px 28px;
        font-size: 14px;
        font-weight: 900;
        cursor: pointer;
        box-shadow: 4px 4px 0px #ff5964;
        transition: transform 0.15s ease;
      }
      .cg-intro-btn:hover {
        transform: translate(-2px, -2px);
      }

      /* Native Scoreboard Widget */
      #cg-native-widget {
        position: fixed;
        top: 20px;
        right: 20px;
        width: 330px;
        background: #ffffff;
        border: 3px solid #000000;
        border-radius: 18px;
        box-shadow: 6px 6px 0px #000000;
        color: #000000;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        z-index: 999999;
        overflow: hidden;
        user-select: none;
        opacity: 0;
        transform: scale(0.65) translateY(-32px) rotate(-4deg);
        transform-origin: top center;
        touch-action: none;
        transition: opacity 0.4s ease, transform 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
      }
      #cg-native-widget.cg-shown {
        opacity: 1;
        transform: scale(1) translateY(0) rotate(0deg);
      }
      #cg-native-widget.cg-dragging {
        transition: none !important;
        cursor: grabbing !important;
        box-shadow: 10px 10px 0px #000000 !important;
        transform: scale(1.02) !important;
        opacity: 0.96;
      }
      #cg-native-widget.cg-dragging .cg-header {
        cursor: grabbing !important;
      }
      #cg-native-widget.minimized .cg-content-body {
        display: none !important;
      }
      .cg-header {
        padding: 10px 14px;
        background: #ffe082;
        border-bottom: 2.5px solid #000000;
        display: flex;
        align-items: center;
        justify-content: space-between;
        cursor: grab;
        user-select: none;
        touch-action: none;
      }
      .cg-header:active {
        cursor: grabbing;
      }
      .cg-header-left {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .cg-logo-icon {
        width: 24px;
        height: 24px;
        background: #ff5964;
        border: 2px solid #000000;
        border-radius: 6px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 11px;
        font-weight: 900;
        color: #ffffff;
        box-shadow: 2px 2px 0px #000000;
        transform: rotate(-3deg);
      }
      .cg-title {
        font-size: 13px;
        font-weight: 800;
        letter-spacing: -0.2px;
        color: #000000;
      }
      .cg-round-badge {
        font-size: 11px;
        font-weight: 900;
        background: #ffffff;
        border: 1.5px solid #000000;
        padding: 2px 8px;
        border-radius: 999px;
        font-family: monospace;
        color: #000000;
        box-shadow: 1.5px 1.5px 0px #000000;
      }
      .cg-header-actions {
        display: flex;
        align-items: center;
        gap: 4px;
      }
      .cg-btn-icon {
        background: #ffffff;
        border: 1.5px solid #000000;
        color: #000000;
        font-size: 12px;
        cursor: pointer;
        padding: 2px 6px;
        border-radius: 6px;
        box-shadow: 1.5px 1.5px 0px #000000;
        font-weight: 800;
      }
      .cg-btn-icon:hover {
        background: #f1f5f9;
        transform: translate(-1px, -1px);
      }
      .cg-status-row {
        padding: 6px 14px;
        background: #c8f560;
        border-bottom: 2px solid #000000;
        display: flex;
        justify-content: space-between;
        align-items: center;
        font-size: 11px;
        font-weight: 800;
        color: #000000;
      }
      .cg-status-open {
        color: #000000;
        display: flex;
        align-items: center;
        gap: 5px;
      }
      .cg-status-closed {
        color: #64748b;
        display: flex;
        align-items: center;
        gap: 5px;
      }
      .cg-status-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        border: 1.5px solid #000000;
        background: #22c55e;
      }
      .cg-list {
        max-height: 280px;
        overflow-y: auto;
        padding: 4px 0;
        background: #ffffff;
      }
      .cg-player-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 6px 14px;
        border-bottom: 1px solid #f1f5f9;
        font-size: 12px;
        color: #000000;
        cursor: pointer;
        transition: background 0.15s;
      }
      .cg-player-row:hover {
        background: #fef08a;
      }
      .cg-rank-gold { color: #b45309; font-weight: 900; }
      .cg-rank-silver { color: #475569; font-weight: 800; }
      .cg-rank-bronze { color: #9a3412; font-weight: 800; }
      .cg-empty-text {
        padding: 16px;
        text-align: center;
        font-size: 11px;
        color: #64748b;
        font-weight: 700;
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
        background: #ffffff;
        border: 2px solid #000000;
        padding: 8px 14px;
        border-radius: 12px;
        box-shadow: 4px 4px 0px #000000;
        color: #000000;
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 12px;
        font-weight: 800;
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
          <span class="cg-title" id="cg-map-title">MabarBang Live</span>
          <span class="cg-round-badge" id="cg-round-badge">R1 / 5</span>
        </div>
        <div class="cg-header-actions">
          <button class="cg-btn-icon" id="cg-btn-server-mode" title="Ganti Server (Local / Cloud)" style="font-size: 11px; padding: 2px 7px;">⚡ Local</button>
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

    // Fullscreen Intro Curtain (Preloader that morphs/shrinks into the top-right overlay)
    const curtain = document.createElement('div');
    curtain.id = 'cg-intro-curtain';
    curtain.innerHTML = `
      <div class="cg-curtain-slab cg-curtain-top"></div>
      <div class="cg-curtain-slab cg-curtain-bottom"></div>
      <div class="cg-intro-card-wrap">
        <div class="cg-intro-card">
          <div class="cg-intro-sticker cg-sticker-tl">✦ MABARBANG ✦</div>
          <div class="cg-intro-sticker cg-sticker-tr">★ 2026 EDITION ★</div>
          <h1 class="cg-intro-title">MABAR BANG</h1>
          <div class="cg-intro-badge">
            <span>⚡</span>
            <span>kikobooo</span>
            <span style="color:#ffe082;">✕</span>
            <span>arvana prod</span>
            <span>⚡</span>
          </div>
          <div class="cg-intro-bar-outer">
            <div class="cg-intro-bar-inner"></div>
          </div>
          <button class="cg-intro-btn" id="cg-intro-btn-start">GASKEUN! ➔</button>
        </div>
      </div>
    `;
    document.body.appendChild(curtain);

    let introDismissed = false;
    const dismissIntro = () => {
      if (introDismissed) return;
      introDismissed = true;
      curtain.classList.add('dismissed');

      // Munculkan & kecilkan ke widget overlay di pojok kanan atas
      setTimeout(() => {
        widget.classList.add('cg-shown');
      }, 200);

      setTimeout(() => {
        curtain.remove();
      }, 700);
    };

    // Klik tombol / klik curtain untuk skip intro
    curtain.onclick = dismissIntro;
    const startBtn = document.getElementById('cg-intro-btn-start');
    if (startBtn) startBtn.onclick = (e) => { e.stopPropagation(); dismissIntro(); };

    // Otomatis mengecil ke overlay setelah 1.8 detik
    setTimeout(() => {
      dismissIntro();
    }, 1800);

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

    const serverModeBtn = document.getElementById('cg-btn-server-mode');
    if (serverModeBtn) {
      serverModeBtn.onclick = (e) => {
        e.stopPropagation();
        openServerModal();
      };
    }

    // Bottom-Right Status Badge
    createBadgeUI();

    // Enable simple dragging
    enableDrag(widget, document.getElementById('cg-drag-handle'));

    // Update Server Mode label in UI
    updateServerModeUI();

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

    let allGuesses = [...(currentState.roundGuesses || [])];

    // Jika ronde selesai / tebakan ditutup dan streamer sudah menebak di ronde ini, masukkan ke daftar jawaban
    const streamerData = currentState.streamerStats || latestStreamerGuess;
    const hasStreamerGuessedThisRound =
      !currentState.guessesOpen &&
      streamerData &&
      (
        (typeof streamerData.roundScore === 'number' && streamerData.roundScore > 0) ||
        (typeof streamerData.roundDistance === 'number' && streamerData.roundDistance > 0) ||
        (typeof streamerData.score === 'number' && streamerData.score > 0)
      );

    if (hasStreamerGuessedThisRound) {
      const sScore = typeof streamerData.roundScore === 'number'
        ? streamerData.roundScore
        : (typeof streamerData.score === 'number' ? streamerData.score : 0);
      const sDist = typeof streamerData.roundDistance === 'number'
        ? streamerData.roundDistance
        : (typeof streamerData.distance === 'number' ? streamerData.distance : 0);

      const existingIdx = allGuesses.findIndex((g) => g.userId === 'streamer');
      const streamerItem = {
        userId: 'streamer',
        username: '👑 Streamer',
        avatar: '',
        position: streamerData.lat && streamerData.lng ? { lat: streamerData.lat, lng: streamerData.lng } : null,
        distance: sDist,
        score: sScore,
        isStreamer: true
      };

      if (existingIdx !== -1) {
        allGuesses[existingIdx] = streamerItem;
      } else {
        allGuesses.push(streamerItem);
      }

      // Sortir urutan jawaban berdasarkan skor tertinggi lalu jarak terdekat
      allGuesses.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.distance - b.distance;
      });
    }

    totalGuesses.textContent = `${allGuesses.length} Guesses`;

    if (allGuesses.length === 0) {
      listContainer.innerHTML =
        '<div class="cg-empty-text">Ketik <code>!g [nama_kota]</code> di YouTube chat!</div>';
      return;
    }

    let html = '';
    allGuesses.slice(0, 10).forEach((p, idx) => {
      const rank = idx + 1;
      let rankClass = '';
      if (rank === 1) rankClass = 'cg-rank-gold';
      else if (rank === 2) rankClass = 'cg-rank-silver';
      else if (rank === 3) rankClass = 'cg-rank-bronze';

      const isStreamer = p.isStreamer || p.userId === 'streamer';
      const isDonation = p.platform === 'geoindo' || p.platform === 'Tako' || (p.userId && p.userId.startsWith('geoindo_'));
      const streamerRowStyle = isStreamer
        ? 'background: #fef08a !important; border-left: 4px solid #f59e0b !important; box-shadow: inset 0 0 0 1px rgba(245, 158, 11, 0.3); font-weight: 800;'
        : (isDonation ? 'background: #f0fdf4 !important; border-left: 3.5px solid #10b981 !important;' : '');
      const streamerBadge = isStreamer
        ? '<span style="background: #f59e0b; color: #000; font-size: 9px; font-weight: 900; padding: 1px 6px; border-radius: 999px; border: 1px solid #000; margin-left: 4px; box-shadow: 1px 1px 0 #000;">STREAMER</span>'
        : (isDonation ? '<span style="background: #10b981; color: #fff; font-size: 9px; font-weight: 900; padding: 1px 5px; border-radius: 999px; border: 1px solid #000; margin-left: 4px;" title="Donasi GeoIndo">💸 DONASI</span>' : '');
      const scoreColor = isStreamer ? '#b45309' : (isDonation ? '#047857' : '#0284c7');

      html += `
        <div class="cg-player-row" data-user-id="${p.userId}" style="${streamerRowStyle}" title="Klik untuk fokus pin di peta">
          <div style="display: flex; align-items: center; gap: 6px; overflow: hidden;">
            <span class="${rankClass}" style="width: 14px; text-align: right; flex-shrink: 0;">${rank}</span>
            <span style="font-weight: ${isStreamer ? '900' : '600'}; max-width: 110px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #000000;">
              ${escapeHtml(p.username)}
            </span>
            ${streamerBadge}
          </div>
          <div style="text-align: right; flex-shrink: 0;">
            <span style="font-weight: 800; color: ${scoreColor}; font-size: 13px;">${p.score.toLocaleString()}</span>
            <span style="color: #64748b; font-size: 10px; margin-left: 4px;">${p.distance} km</span>
          </div>
        </div>
      `;
    });

    listContainer.innerHTML = html;

    // Attach click listeners to pan map to player position
    listContainer.querySelectorAll('.cg-player-row').forEach((row, i) => {
      row.onclick = () => {
        const player = allGuesses[i];
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
    div.style.background = '#ffffff';
    div.style.border = '2.5px solid #000000';
    div.style.borderRadius = '9999px';
    div.style.padding = '6px 14px';
    div.style.color = '#000000';
    div.style.fontSize = '12px';
    div.style.fontWeight = '800';
    div.style.display = 'flex';
    div.style.alignItems = 'center';
    div.style.gap = '8px';
    div.style.cursor = 'pointer';
    div.style.boxShadow = '4px 4px 0px #000000';

    div.innerHTML = `
      <span id="cg-bridge-dot" style="width: 8px; height: 8px; border-radius: 50%; border: 1.5px solid #000; background: #94a3b8;"></span>
      <span id="cg-bridge-text" style="font-weight: 800; color: #000;">MabarBang</span>
      <span id="cg-bridge-mode" style="background: #c8f560; border: 1.5px solid #000; border-radius: 999px; padding: 2px 8px; margin-left: 2px; font-size: 11px; font-weight: 800; color: #000; box-shadow: 1.5px 1.5px 0px #000;" title="Klik untuk pilih Server Local / Cloud">⚡ Local</span>
      <span id="cg-overlay-toggle" style="background: #ffe082; border: 1.5px solid #000; border-radius: 999px; padding: 2px 8px; margin-left: 4px; font-size: 11px; font-weight: 800; color: #000; box-shadow: 1.5px 1.5px 0px #000;">Hide Overlay</span>
    `;

    div.onclick = (e) => {
      if (e.target && e.target.id === 'cg-overlay-toggle') {
        const widget = document.getElementById('cg-native-widget');
        if (!widget) return;
        if (widget.style.display === 'none') {
          widget.style.display = 'block';
          widget.style.animation = 'none';
          void widget.offsetWidth; // force browser reflow
          widget.style.animation = 'cgWidgetPopIn 0.45s cubic-bezier(0.34, 1.56, 0.64, 1) forwards';
          e.target.textContent = 'Hide Overlay';
        } else {
          widget.style.display = 'none';
          e.target.textContent = 'Show Overlay';
        }
        return;
      }

      openServerModal();
    };

    document.body.appendChild(div);
    updateServerModeUI();
  }

  function updateServerModeUI() {
    const mode = getServerMode();
    const btn = document.getElementById('cg-btn-server-mode');
    const badgeMode = document.getElementById('cg-bridge-mode');

    let label = '⚡ Local';
    let bg = '#c8f560';

    if (mode === 'cloud') {
      label = '☁️ Cloud';
      bg = '#ffe082';
    } else if (mode === 'custom') {
      label = '🌐 Custom';
      bg = '#70d6ff';
    }

    if (btn) {
      btn.textContent = label;
      btn.title = `Server: ${serverUrl} (Klik untuk pilih Local/Cloud)`;
    }
    if (badgeMode) {
      badgeMode.textContent = label;
      badgeMode.style.background = bg;
      badgeMode.title = `Server: ${serverUrl} (Klik untuk pilih Local/Cloud)`;
    }
  }

  function openServerModal() {
    let modal = document.getElementById('cg-server-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'cg-server-modal';
      modal.style.cssText = `
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.65);
        backdrop-filter: blur(4px);
        z-index: 10000000;
        display: flex;
        align-items: center;
        justify-content: center;
        animation: cgFadeIn 0.2s ease;
      `;
      modal.onclick = (e) => {
        if (e.target === modal) modal.style.display = 'none';
      };
      document.body.appendChild(modal);
    }

    const renderModalContent = () => {
      const currentMode = getServerMode();
      modal.innerHTML = `
        <div style="
          background: #ffffff;
          border: 3.5px solid #000;
          border-radius: 24px;
          box-shadow: 8px 8px 0px #000;
          padding: 24px 26px;
          max-width: 390px;
          width: 90vw;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          color: #000;
          animation: cgWidgetPopIn 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
        " onclick="event.stopPropagation()">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px;">
            <h3 style="font-size: 17px; font-weight: 900; margin: 0; display: flex; align-items: center; gap: 6px;">
              <span>🌐</span> Pilih Server MabarBang
            </h3>
            <button id="cg-close-modal" style="
              background: #ff5964;
              color: #fff;
              border: 2px solid #000;
              border-radius: 50%;
              width: 28px;
              height: 28px;
              cursor: pointer;
              font-weight: 900;
              box-shadow: 2px 2px 0px #000;
            ">✕</button>
          </div>

          <p style="font-size: 12px; color: #475569; font-weight: 700; margin-bottom: 16px;">
            Pilih server untuk menghubungkan tebakan viewer YouTube ke GeoGuessr:
          </p>

          <div style="display: flex; flex-direction: column; gap: 10px; margin-bottom: 14px;">
            <!-- Tombol Local Server -->
            <button id="cg-btn-local" style="
              display: flex;
              align-items: center;
              justify-content: space-between;
              background: ${currentMode === 'local' ? '#c8f560' : '#f8fafc'};
              border: 2.5px solid #000;
              border-radius: 14px;
              padding: 12px 14px;
              cursor: pointer;
              box-shadow: ${currentMode === 'local' ? '4px 4px 0px #000' : '2px 2px 0px #000'};
              text-align: left;
              transition: all 0.15s ease;
            ">
              <div>
                <div style="font-size: 14px; font-weight: 900; display: flex; align-items: center; gap: 6px;">
                  <span>💻</span> Local Server (PC Ini)
                  ${currentMode === 'local' ? '<span style="background: #000; color: #fff; font-size: 9px; padding: 2px 6px; border-radius: 99px;">AKTIF</span>' : ''}
                </div>
                <div style="font-size: 11px; color: #475569; font-weight: 700; margin-top: 2px;">
                  http://localhost:5050 (Standalone / Local)
                </div>
              </div>
              <span style="font-size: 16px; font-weight: 900;">${currentMode === 'local' ? '✓' : '➔'}</span>
            </button>

            <!-- Tombol Cloud Server -->
            <button id="cg-btn-cloud" style="
              display: flex;
              align-items: center;
              justify-content: space-between;
              background: ${currentMode === 'cloud' ? '#ffe082' : '#f8fafc'};
              border: 2.5px solid #000;
              border-radius: 14px;
              padding: 12px 14px;
              cursor: pointer;
              box-shadow: ${currentMode === 'cloud' ? '4px 4px 0px #000' : '2px 2px 0px #000'};
              text-align: left;
              transition: all 0.15s ease;
            ">
              <div>
                <div style="font-size: 14px; font-weight: 900; display: flex; align-items: center; gap: 6px;">
                  <span>☁️</span> Cloud Server (Railway)
                  ${currentMode === 'cloud' ? '<span style="background: #000; color: #fff; font-size: 9px; padding: 2px 6px; border-radius: 99px;">AKTIF</span>' : ''}
                </div>
                <div style="font-size: 11px; color: #475569; font-weight: 700; margin-top: 2px;">
                  geoindo.up.railway.app
                </div>
              </div>
              <span style="font-size: 16px; font-weight: 900;">${currentMode === 'cloud' ? '✓' : '➔'}</span>
            </button>

            <!-- Tombol Custom Server -->
            <button id="cg-btn-custom" style="
              display: flex;
              align-items: center;
              justify-content: space-between;
              background: ${currentMode === 'custom' ? '#70d6ff' : '#f8fafc'};
              border: 2px solid #000;
              border-radius: 12px;
              padding: 10px 14px;
              cursor: pointer;
              box-shadow: ${currentMode === 'custom' ? '3px 3px 0px #000' : '2px 2px 0px #000'};
              text-align: left;
            ">
              <div style="font-size: 12px; font-weight: 800;">
                <span>⚙️</span> Custom URL Server...
                ${currentMode === 'custom' ? '<span style="background: #000; color: #fff; font-size: 9px; padding: 2px 6px; border-radius: 99px; margin-left: 6px;">AKTIF</span>' : ''}
              </div>
              <span style="font-size: 13px;">${currentMode === 'custom' ? '✓' : '✎'}</span>
            </button>

            <!-- Streamer ID Configuration (Multi-User) -->
            <div style="margin-top: 8px; padding-top: 10px; border-top: 2px dashed #000;">
              <div style="font-size: 12px; font-weight: 900; margin-bottom: 4px; display: flex; align-items: center; justify-content: space-between;">
                <span>👤 Streamer ID (Multi-User)</span>
                <span style="font-size: 10px; color: #64748b;">${streamerId ? 'Tersimpan' : 'Default / Auto'}</span>
              </div>
              <div style="display: flex; gap: 6px;">
                <input type="text" id="cg-input-streamer-id" placeholder="UID Streamer Supabase" value="${streamerId || ''}" style="
                  flex: 1;
                  padding: 8px 10px;
                  background: #fff;
                  border: 2px solid #000;
                  border-radius: 8px;
                  font-size: 11px;
                  font-weight: 700;
                  outline: none;
                ">
                <button id="cg-btn-save-streamer" style="
                  background: #c8f560;
                  border: 2px solid #000;
                  border-radius: 8px;
                  padding: 8px 12px;
                  font-size: 11px;
                  font-weight: 900;
                  cursor: pointer;
                  box-shadow: 2px 2px 0px #000;
                ">Simpan</button>
              </div>
            </div>
          </div>
        </div>
      `;

      document.getElementById('cg-close-modal').onclick = () => {
        modal.style.display = 'none';
      };

      const btnSaveStreamer = document.getElementById('cg-btn-save-streamer');
      if (btnSaveStreamer) {
        btnSaveStreamer.onclick = () => {
          const val = document.getElementById('cg-input-streamer-id').value.trim();
          setStreamerId(val);
          renderModalContent();
        };
      }

      document.getElementById('cg-btn-local').onclick = () => {
        setServerUrl(LOCAL_SERVER_URL, 'Local (5050)');
        renderModalContent();
        setTimeout(() => {
          modal.style.display = 'none';
        }, 220);
      };

      document.getElementById('cg-btn-cloud').onclick = () => {
        setServerUrl(CLOUD_SERVER_URL, 'Cloud (Railway)');
        renderModalContent();
        setTimeout(() => {
          modal.style.display = 'none';
        }, 220);
      };

      document.getElementById('cg-btn-custom').onclick = () => {
        const customUrl = prompt('Masukkan URL Server Custom:', serverUrl);
        if (customUrl && customUrl.trim()) {
          setServerUrl(customUrl.trim(), 'Custom');
          renderModalContent();
          setTimeout(() => {
            modal.style.display = 'none';
          }, 220);
        }
      };
    };

    renderModalContent();
    modal.style.display = 'flex';
  }

  function updateBadgeStatus(connected) {
    const dot = document.getElementById('cg-bridge-dot');
    const text = document.getElementById('cg-bridge-text');
    if (dot && text) {
      dot.style.background = connected ? '#10b981' : '#ef4444';
      text.textContent = connected ? 'MabarBang: Connected' : 'MabarBang: Offline';
    }
  }

  function enableDrag(element, handle) {
    let startX = 0,
      startY = 0;
    let initialLeft = 0,
      initialTop = 0;
    let isDragging = false;

    // Restore saved position if available
    try {
      const savedPos = localStorage.getItem('cg_widget_pos');
      if (savedPos) {
        const { left, top } = JSON.parse(savedPos);
        const maxL = Math.max(10, window.innerWidth - 340);
        const maxT = Math.max(10, window.innerHeight - 100);
        const clampL = Math.max(10, Math.min(left, maxL));
        const clampT = Math.max(10, Math.min(top, maxT));
        element.style.left = clampL + 'px';
        element.style.top = clampT + 'px';
        element.style.right = 'auto';
      }
    } catch (_) { }

    // Double click header to reset to default top-right corner
    handle.addEventListener('dblclick', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      element.style.top = '20px';
      element.style.right = '20px';
      element.style.left = 'auto';
      try {
        localStorage.removeItem('cg_widget_pos');
      } catch (_) { }
    });

    handle.addEventListener('pointerdown', onPointerDown);

    function onPointerDown(e) {
      if (e.target.tagName === 'BUTTON' || (e.button !== undefined && e.button !== 0)) return;
      e.preventDefault();

      const rect = element.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      initialLeft = rect.left;
      initialTop = rect.top;

      isDragging = true;
      element.classList.add('cg-dragging');
      element.style.left = initialLeft + 'px';
      element.style.top = initialTop + 'px';
      element.style.right = 'auto';

      handle.setPointerCapture(e.pointerId);
      handle.addEventListener('pointermove', onPointerMove);
      handle.addEventListener('pointerup', onPointerUp);
      handle.addEventListener('pointercancel', onPointerUp);
    }

    function onPointerMove(e) {
      if (!isDragging) return;
      e.preventDefault();

      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      let newLeft = initialLeft + dx;
      let newTop = initialTop + dy;

      const padding = 10;
      const maxLeft = Math.max(padding, window.innerWidth - element.offsetWidth - padding);
      const maxTop = Math.max(padding, window.innerHeight - element.offsetHeight - padding);

      newLeft = Math.max(padding, Math.min(newLeft, maxLeft));
      newTop = Math.max(padding, Math.min(newTop, maxTop));

      element.style.left = newLeft + 'px';
      element.style.top = newTop + 'px';
    }

    function onPointerUp(e) {
      if (!isDragging) return;
      isDragging = false;
      element.classList.remove('cg-dragging');

      handle.removeEventListener('pointermove', onPointerMove);
      handle.removeEventListener('pointerup', onPointerUp);
      handle.removeEventListener('pointercancel', onPointerUp);
      try {
        handle.releasePointerCapture(e.pointerId);
      } catch (_) { }

      // Save position for persistence across reloads / rounds
      try {
        const rect = element.getBoundingClientRect();
        localStorage.setItem(
          'cg_widget_pos',
          JSON.stringify({ left: Math.round(rect.left), top: Math.round(rect.top) })
        );
      } catch (_) { }
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
