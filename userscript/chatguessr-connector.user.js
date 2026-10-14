// ==UserScript==
// @name         ChatGuessr YouTube - GeoGuessr Auto Connector
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Otomatis mengirim game token & lokasi ronde GeoGuessr ke Server ChatGuessr Railway Anda
// @author       ChatGuessr
// @match        *://*.geoguessr.com/*
// @run-at       document-start
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// ==/UserScript==

(function () {
  'use strict';

  // Default server URL (bisa diganti lewat tombol di layar)
  const DEFAULT_SERVER_URL = 'http://localhost:3000';
  let serverUrl = (typeof GM_getValue !== 'undefined' ? GM_getValue('cg_server_url', DEFAULT_SERVER_URL) : localStorage.getItem('cg_server_url')) || DEFAULT_SERVER_URL;

  console.log('[ChatGuessr Connector] Initialized with Server:', serverUrl);

  // Hook window.fetch to capture GeoGuessr API responses
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);
    const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');

    if (url.includes('/api/v3/games/')) {
      try {
        const clone = response.clone();
        clone.json().then((gameData) => {
          handleGeoGuessrGameData(gameData);
        }).catch(() => {});
      } catch (err) {
        console.error('[ChatGuessr Connector] Error reading response clone:', err);
      }
    }

    return response;
  };

  let lastReportedRound = 0;
  let lastReportedToken = '';
  let lastReportedGuessesCount = -1;

  function handleGeoGuessrGameData(data) {
    if (!data || !data.token || !data.rounds) return;

    const token = data.token;
    const roundNumber = data.round || data.rounds.length;
    const currentRoundLocation = data.rounds[roundNumber - 1];
    const mapName = data.mapName || 'GeoGuessr';
    const bounds = data.bounds;
    const guessesCount = data.player?.guesses?.length || 0;
    const isGameFinished = data.state === 'finished';

    // Cek apakah streamer baru saja menebak (ronde selesai)
    const isRoundFinished = guessesCount === roundNumber;

    // Hindari spam kirim update berulang yang sama
    const stateKey = `${token}_R${roundNumber}_G${guessesCount}_F${isGameFinished ? 1 : 0}`;
    if (window.__lastCgStateKey === stateKey) {
      return;
    }
    window.__lastCgStateKey = stateKey;

    console.log('[ChatGuessr Connector] Sending Game Update:', {
      token,
      round: roundNumber,
      mapName,
      isRoundFinished,
      isGameFinished
    });

    const payload = {
      token,
      mapName,
      round: roundNumber,
      location: currentRoundLocation ? { lat: currentRoundLocation.lat, lng: currentRoundLocation.lng } : null,
      bounds,
      roundFinished: isRoundFinished,
      gameFinished: isGameFinished
    };

    sendToServer(payload);
  }

  function sendToServer(payload) {
    const targetUrl = serverUrl.replace(/\/$/, '') + '/api/geoguessr/update';

    if (typeof GM_xmlhttpRequest !== 'undefined') {
      GM_xmlhttpRequest({
        method: 'POST',
        url: targetUrl,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify(payload),
        onload: (res) => {
          updateBadgeStatus(true);
        },
        onerror: (err) => {
          console.warn('[ChatGuessr Connector] Failed to reach server:', err);
          updateBadgeStatus(false);
        }
      });
    } else {
      fetch(targetUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }).then(() => updateBadgeStatus(true))
        .catch(() => updateBadgeStatus(false));
    }
  }

  // Floating Status UI in bottom right corner
  function createUI() {
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
    div.style.fontFamily = 'sans-serif';
    div.style.display = 'flex';
    div.style.alignItems = 'center';
    div.style.gap = '8px';
    div.style.cursor = 'pointer';
    div.style.boxShadow = '0 4px 12px rgba(0,0,0,0.5)';
    div.title = 'Klik untuk ganti Server URL ChatGuessr';

    div.innerHTML = `
      <span id="cg-bridge-dot" style="width: 8px; height: 8px; border-radius: 50%; background: #94a3b8;"></span>
      <span id="cg-bridge-text" style="font-weight: 600;">ChatGuessr Bridge</span>
    `;

    div.onclick = () => {
      const newUrl = prompt('Masukkan URL Server ChatGuessr Railway Anda:', serverUrl);
      if (newUrl) {
        serverUrl = newUrl.trim();
        if (typeof GM_setValue !== 'undefined') GM_setValue('cg_server_url', serverUrl);
        localStorage.setItem('cg_server_url', serverUrl);
        alert('Server URL disimpan: ' + serverUrl);
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

  window.addEventListener('DOMContentLoaded', createUI);
  setTimeout(createUI, 2000);
})();
