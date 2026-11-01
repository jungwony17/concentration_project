(() => {
  "use strict";

  // Apps Script 웹 앱을 배포한 뒤 URL(/exec)을 여기에 붙여 넣으세요.
  // 예: https://script.google.com/macros/s/AKfy.../exec
  const SHEETS_WEB_APP_URL = "https://script.google.com/macros/s/AKfycbz4Y7rEVyGOkcA8O2L6doM8RFAyWqsZO_9jy-EdYMakmwmo64gFNEYojI-pC1Ooy7qXSA/exec";

  const $ = (id) => document.getElementById(id);
  const ui = {
    intro: $("intro"), cal: $("calibration"), game: $("game"), results: $("results"),
    status: $("statusPill"), code: $("participantCode"), startMouse: $("startMouse"),
    startEye: $("startEye"), dots: [...document.querySelectorAll(".cal-dot")],
    calStatus: $("calStatus"), cancel: $("cancelCalibration"), time: $("timeLeft"),
    mode: $("modeLabel"), phase: $("phaseLabel"), field: $("playfield"),
    target: $("target"), pointer: $("pointerDot"), hint: $("gameHint"),
    gazeLegend: $("gazeLegend"), stop: $("stopGame"),
    summary: $("resultSummary"), metrics: $("metrics"), phaseResults: $("phaseResults"),
    history: $("historyRows"), csv: $("downloadCsv"), again: $("again"), clear: $("clearHistory"),
    testSheetsConnection: $("testSheetsConnection"), sheetsSetupStatus: $("sheetsSetupStatus"),
    sheetsUploadStatus: $("sheetsUploadStatus"), sendSheetsAgain: $("sendSheetsAgain")
  };

  const DURATION = 60;
  const MOVE_SECONDS = 16;
  const SAMPLE_MS = 100;
  const GAZE_MAX_AGE_MS = 350;
  const HISTORY_KEY = "focusLabDualTrackingSessionsV2";
  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
  const show = (el) => el.classList.remove("hidden");
  const hide = (el) => el.classList.add("hidden");

  let mode = "mouse"; // mouse | combined
  let running = false;
  let calibrating = false;
  let startedAt = 0;
  let raf = 0;
  let webgazerStarted = false;
  let lastGaze = null;
  let gazeSmooth = null;
  let lastGazeAt = 0;
  let lastPointer = null;
  let samples = [];
  let lastSampleAt = 0;
  let latestSession = null;

  function view(which) {
    [ui.intro, ui.cal, ui.game, ui.results].forEach(hide);
    show(which);
  }

  function phaseName(seconds) {
    return seconds < 20 ? "초반" : seconds < 40 ? "중반" : "후반";
  }

  function pointFromViewport(clientX, clientY) {
    const rect = ui.field.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return null;
    return {
      x: clamp((clientX - rect.left) / rect.width, 0, 1),
      y: clamp((clientY - rect.top) / rect.height, 0, 1)
    };
  }

  function distance(a, b) {
    return Math.hypot(
      (a.x - b.x) * ui.field.clientWidth,
      (a.y - b.y) * ui.field.clientHeight
    );
  }

  const path = [
    { x: .18, y: .23 }, { x: .79, y: .18 }, { x: .80, y: .75 },
    { x: .20, y: .80 }, { x: .50, y: .48 }, { x: .83, y: .48 },
    { x: .28, y: .38 }, { x: .65, y: .78 }, { x: .38, y: .22 }
  ];

  function targetAt(now) {
    const elapsed = now - startedAt;
    const segment = Math.floor(elapsed / (MOVE_SECONDS * 1000));
    const progress = (elapsed % (MOVE_SECONDS * 1000)) / (MOVE_SECONDS * 1000);
    const smooth = progress * progress * (3 - 2 * progress);
    const a = path[segment % path.length];
    const b = path[(segment + 1) % path.length];
    return { x: a.x + (b.x - a.x) * smooth, y: a.y + (b.y - a.y) * smooth };
  }

  // The visible green marker is ONLY the mouse/touch pointer.
  // Gaze coordinates are deliberately never drawn on screen.
  function drawPointer(point) {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
    ui.pointer.style.left = `${point.x * 100}%`;
    ui.pointer.style.top = `${point.y * 100}%`;
    show(ui.pointer);
  }

  function isPointerMode() {
    return running && (mode === "mouse" || mode === "combined");
  }

  ui.field.addEventListener("pointerdown", (event) => {
    if (!isPointerMode()) return;
    try { ui.field.setPointerCapture(event.pointerId); } catch (_) {}
    const p = pointFromViewport(event.clientX, event.clientY);
    if (p) {
      lastPointer = p;
      drawPointer(p);
    }
  });

  ui.field.addEventListener("pointermove", (event) => {
    if (!isPointerMode()) return;
    const p = pointFromViewport(event.clientX, event.clientY);
    if (!p) return;
    lastPointer = p;
    drawPointer(p);
  }, { passive: true });

  ui.field.addEventListener("pointerup", (event) => {
    try {
      if (ui.field.hasPointerCapture(event.pointerId)) ui.field.releasePointerCapture(event.pointerId);
    } catch (_) {}
    // A touch point is no longer actively controlled after the finger lifts.
    if (event.pointerType === "touch" && running) {
      lastPointer = null;
      hide(ui.pointer);
    }
  });

  ui.field.addEventListener("pointercancel", () => {
    if (isPointerMode()) {
      lastPointer = null;
      hide(ui.pointer);
    }
  });

  ui.field.addEventListener("pointerleave", (event) => {
    if (isPointerMode() && event.pointerType === "mouse") {
      lastPointer = null;
      hide(ui.pointer);
    }
  }, { passive: true });

  function safeWebGazerCall(webgazer, method, ...args) {
    if (typeof webgazer?.[method] !== "function") return false;
    try {
      webgazer[method](...args);
      return true;
    } catch (error) {
      console.warn(`WebGazer ${method} 설정을 건너뜁니다.`, error);
      return false;
    }
  }

  async function stopWebGazer(force = false) {
    const webgazer = window.webgazer;
    if (!webgazer || (!webgazerStarted && !force)) return;
    webgazerStarted = false;
    try {
      if (typeof webgazer.end === "function") await Promise.resolve(webgazer.end());
    } catch (error) {
      console.warn("WebGazer 종료 중 오류:", error);
    }
  }

  async function startEye() {
    const host = location.hostname;
    const isLocalhost = host === "localhost";
    const isHttps = location.protocol === "https:";
    if (!isHttps && !isLocalhost) {
      alert("아이트래킹을 시작하려면 주소를 localhost 또는 HTTPS로 열어 주세요.\n예: http://localhost:5500/index.html");
      return;
    }
    if (!window.isSecureContext) {
      alert("현재 페이지가 보안 연결로 인식되지 않아요. localhost 또는 HTTPS 주소로 열어 주세요.");
      return;
    }

    const webgazer = window.webgazer;
    if (!webgazer) {
      alert("시선 추적 모듈을 불러오지 못했어요. 인터넷 연결을 확인한 뒤 새로고침해 주세요.");
      return;
    }
    if (typeof webgazer.begin !== "function" || typeof webgazer.setGazeListener !== "function") {
      alert("불러온 시선 추적 모듈의 API가 올바르지 않아요. 페이지를 새로고침해 주세요.");
      return;
    }

    mode = "combined";
    running = false;
    calibrating = true;
    lastGaze = null;
    gazeSmooth = null;
    lastGazeAt = 0;
    view(ui.cal);
    ui.status.textContent = "카메라 연결 중";
    ui.calStatus.textContent = "카메라 권한과 시선 모델을 준비하고 있어요…";

    let startupStage = "초기 설정";
    try {
      safeWebGazerCall(webgazer, "saveDataAcrossSessions", false);
      safeWebGazerCall(webgazer, "setRegression", "ridge");
      safeWebGazerCall(webgazer, "applyKalmanFilter", true);

      startupStage = "시선 좌표 연결";
      webgazer.setGazeListener((data) => {
        if (!running || mode !== "combined" || !data) return;
        if (!Number.isFinite(data.x) || !Number.isFinite(data.y)) return;
        const p = pointFromViewport(data.x, data.y);
        if (!p) return;
        if (!gazeSmooth) gazeSmooth = p;
        else {
          gazeSmooth.x += (p.x - gazeSmooth.x) * 0.32;
          gazeSmooth.y += (p.y - gazeSmooth.y) * 0.32;
        }
        lastGaze = { x: gazeSmooth.x, y: gazeSmooth.y };
        lastGazeAt = performance.now();
        // Intentionally do not call drawPointer() here: gaze stays invisible.
      });

      safeWebGazerCall(webgazer, "showVideoPreview", true);
      safeWebGazerCall(webgazer, "showFaceOverlay", false);
      safeWebGazerCall(webgazer, "showFaceFeedbackBox", false);
      safeWebGazerCall(webgazer, "showPredictionPoints", false);

      startupStage = "카메라 및 시선 모델 시작";
      const beginResult = webgazer.begin();
      if (beginResult && typeof beginResult.then === "function") await beginResult;
      webgazerStarted = true;

      let clicked = 0;
      ui.dots.forEach((dot) => {
        dot.disabled = false;
        dot.style.opacity = "1";
        dot.onclick = () => {
          if (!calibrating || dot.disabled) return;
          clicked += 1;
          dot.disabled = true;
          dot.style.opacity = ".3";
          if (clicked < ui.dots.length) {
            ui.calStatus.textContent = `${clicked + 1}/5 — 점을 바라보며 다음 점을 눌러 주세요.`;
          } else {
            calibrating = false;
            ui.calStatus.textContent = "보정 완료. 포인터와 시선을 동시에 기록합니다.";
            beginGame("combined");
          }
        };
      });
      ui.calStatus.textContent = "1/5 — 첫 번째 점을 바라보며 눌러 주세요.";
      ui.status.textContent = "시선 보정 중";
    } catch (error) {
      calibrating = false;
      console.error("WebGazer 시작 오류:", error);
      await stopWebGazer(true);
      view(ui.intro);
      ui.status.textContent = "카메라 연결 실패";
      console.error(`WebGazer 오류 발생 단계: ${startupStage}`);
      alert(
        "카메라는 연결됐지만 시선 추적 초기화가 중단됐어요." +
        `\n단계: ${startupStage}\n오류: ${error?.message || String(error)}` +
        "\n\n마우스/터치 단독 테스트는 계속 사용할 수 있습니다."
      );
    }
  }

  function beginGame(nextMode) {
    mode = nextMode;
    running = true;
    calibrating = false;
    samples = [];
    lastSampleAt = 0;
    lastPointer = null;
    lastGaze = null;
    gazeSmooth = null;
    lastGazeAt = 0;
    startedAt = performance.now();

    ui.mode.textContent = mode === "combined" ? "포인터 + 시선" : "포인터만";
    ui.gazeLegend.classList.toggle("hidden", mode !== "combined");
    if (mode === "combined") {
      ui.hint.textContent = "초록색 포인터 원으로 노란색 목표 원을 따라가세요. 시선은 보이지 않게 함께 기록됩니다.";
    } else {
      ui.hint.textContent = "초록색 포인터 원으로 노란색 목표 원을 따라가세요.";
    }
    hide(ui.pointer);
    ui.time.textContent = DURATION;
    view(ui.game);
    ui.status.textContent = mode === "combined" ? "포인터·시선 동시 기록 중" : "포인터 기록 중";

    const tick = (now) => {
      if (!running) return;
      const elapsed = (now - startedAt) / 1000;
      ui.time.textContent = Math.max(0, Math.ceil(DURATION - elapsed));
      ui.phase.textContent = phaseName(elapsed);
      const target = targetAt(now);
      ui.target.style.left = `${target.x * 100}%`;
      ui.target.style.top = `${target.y * 100}%`;

      if (now - lastSampleAt >= SAMPLE_MS) {
        const gazeIsFresh = mode === "combined" && lastGaze && (now - lastGazeAt <= GAZE_MAX_AGE_MS);
        const pointerPoint = lastPointer ? { x: lastPointer.x, y: lastPointer.y } : null;
        const gazePoint = gazeIsFresh ? { x: lastGaze.x, y: lastGaze.y } : null;
        samples.push({
          t: Math.min(DURATION, Number(elapsed.toFixed(2))),
          phase: phaseName(elapsed),
          target: { x: target.x, y: target.y },
          pointer: pointerPoint,
          gaze: gazePoint,
          // Store pixel distances while the playfield is visible, so CSV export
          // still has correct values after the results screen hides the field.
          pointerDistancePx: pointerPoint ? Number(distance(target, pointerPoint).toFixed(1)) : null,
          gazeDistancePx: gazePoint ? Number(distance(target, gazePoint).toFixed(1)) : null,
          pointerGazeGapPx: pointerPoint && gazePoint ? Number(distance(pointerPoint, gazePoint).toFixed(1)) : null
        });
        lastSampleAt = now;
      }
      if (elapsed >= DURATION) {
        finish();
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(tick);
  }

  function thresholdPx() {
    return Math.max(55, Math.min(ui.field.clientWidth, ui.field.clientHeight) * 0.13);
  }

  function trackScore(list, key) {
    const valid = list.filter((sample) => sample[key] && Number.isFinite(sample[key].x) && Number.isFinite(sample[key].y));
    const total = list.length;
    if (!valid.length) return { score: null, n: 0, coverage: 0, onTarget: 0 };
    const limit = thresholdPx();
    const close = valid.filter((sample) => distance(sample.target, sample[key]) <= limit).length;
    return {
      score: Math.round((close / valid.length) * 100),
      n: valid.length,
      coverage: Math.round((valid.length / Math.max(1, total)) * 100),
      onTarget: close
    };
  }

  function comparisonScore(list) {
    const comparable = list.filter((s) => s.pointer && s.gaze);
    if (!comparable.length) {
      return { validPairs: 0, pointerOnGazeOffPercent: null, bothOnPercent: null, meanGapPx: null };
    }
    const limit = thresholdPx();
    let pointerOn = 0;
    let gazeOffWhilePointerOn = 0;
    let bothOn = 0;
    let gapTotal = 0;
    for (const s of comparable) {
      const pDist = distance(s.target, s.pointer);
      const gDist = distance(s.target, s.gaze);
      const pOn = pDist <= limit;
      const gOn = gDist <= limit;
      if (pOn) {
        pointerOn += 1;
        if (!gOn) gazeOffWhilePointerOn += 1;
      }
      if (pOn && gOn) bothOn += 1;
      gapTotal += distance(s.pointer, s.gaze);
    }
    return {
      validPairs: comparable.length,
      pointerOnGazeOffPercent: pointerOn ? Math.round((gazeOffWhilePointerOn / pointerOn) * 100) : null,
      bothOnPercent: Math.round((bothOn / comparable.length) * 100),
      meanGapPx: Math.round(gapTotal / comparable.length)
    };
  }

  function analyze(list) {
    return {
      pointer: trackScore(list, "pointer"),
      gaze: trackScore(list, "gaze"),
      comparison: comparisonScore(list)
    };
  }

  function getHistory() {
    try {
      const data = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
      return Array.isArray(data) ? data : [];
    } catch (_) { return []; }
  }

  function getSheetsEndpoint() {
    const raw = String(SHEETS_WEB_APP_URL || "").trim();
    if (!raw || raw.includes("PASTE_YOUR_APPS_SCRIPT_WEB_APP_URL_HERE")) return "";
    try {
      const url = new URL(raw);
      const valid = url.protocol === "https:" &&
        url.hostname === "script.google.com" &&
        /^\/macros\/s\/[^/]+\/exec\/?$/.test(url.pathname);
      return valid ? url.href : "";
    } catch (_) {
      return "";
    }
  }

  function setSheetsSetupStatus(message, isError = false) {
    ui.sheetsSetupStatus.textContent = message;
    ui.sheetsSetupStatus.classList.toggle("status-error", isError);
  }

  function updateSheetsStatus() {
    if (getSheetsEndpoint()) {
      setSheetsSetupStatus("Apps Script 주소가 코드에 설정되어 있습니다. 연결 확인 후 테스트를 진행하세요.");
    } else {
      setSheetsSetupStatus("script.js 맨 위의 SHEETS_WEB_APP_URL에 배포된 Apps Script /exec 주소를 입력해야 합니다.", true);
    }
  }

  function testSheetsConnection() {
    const endpoint = getSheetsEndpoint();
    if (!endpoint) {
      setSheetsSetupStatus("주소가 아직 설정되지 않았습니다. script.js 맨 위 SHEETS_WEB_APP_URL을 수정해 주세요.", true);
      return;
    }
    const testUrl = new URL(endpoint);
    testUrl.searchParams.set("test", "1");
    testUrl.searchParams.set("t", String(Date.now()));
    const opened = window.open(testUrl.href, "_blank");
    if (!opened) {
      setSheetsSetupStatus("팝업이 차단되었습니다. 브라우저에서 팝업을 허용하거나 Apps Script /exec 주소 뒤에 ?test=1을 붙여 새 탭에서 여세요.", true);
      return;
    }
    setSheetsSetupStatus("새 탭에 연결 검사 결과가 열렸습니다. '연결 성공' 메시지가 보이면 시트 쓰기 권한이 확인된 것입니다.");
  }

  function verifySessionSaved(sessionId) {
    const endpoint = getSheetsEndpoint();
    return new Promise((resolve, reject) => {
      const callbackName = `__focusLabVerify_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      const url = new URL(endpoint);
      url.searchParams.set("checkSession", sessionId);
      url.searchParams.set("expectedSamples", String(latestSession?.samples?.length ?? 0));
      url.searchParams.set("prefix", callbackName);
      url.searchParams.set("t", String(Date.now()));

      const script = document.createElement("script");
      let finished = false;
      const cleanup = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        script.remove();
        try { delete window[callbackName]; } catch (_) { window[callbackName] = undefined; }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("저장 여부 확인 시간이 초과됐습니다. Sessions 탭과 Apps Script 실행 기록을 확인해 주세요."));
      }, 20000);

      window[callbackName] = (result) => {
        cleanup();
        const expected = latestSession?.samples?.length ?? 0;
        if (result && result.ok && result.sessionId === sessionId && result.savedSamples === expected) resolve(result);
        else reject(new Error(result?.error || `Sessions 행 또는 Samples 좌표가 완전히 저장되지 않았습니다. (Samples ${result?.savedSamples ?? 0}/${expected}) System 탭과 Apps Script 실행 기록을 확인해 주세요.`));
      };
      script.onerror = () => {
        cleanup();
        reject(new Error("저장 확인 응답을 불러오지 못했습니다. Apps Script /exec 주소와 배포 공개 범위를 확인해 주세요."));
      };
      script.src = url.href;
      document.head.appendChild(script);
    });
  }

  // text/plain avoids a CORS preflight. Apps Script's ContentService redirects
  // its response; the POST response is opaque, so a read-only JSONP lookup then
  // confirms that the session_id is actually present in the Sessions tab.
  async function postSessionToSheets(session) {
    const endpoint = getSheetsEndpoint();
    if (!endpoint) throw new Error("script.js의 SHEETS_WEB_APP_URL을 먼저 설정해 주세요.");

    const payload = { ...session, clientVersion: "FOCUS_LAB_v10" };
    await fetch(endpoint, {
      method: "POST",
      mode: "no-cors",
      redirect: "follow",
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body: JSON.stringify(payload)
    });

    // Retry briefly in case Apps Script has not finished committing the rows.
    let lastError = null;
    for (const delayMs of [0, 700, 1400, 2200]) {
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      try {
        return await verifySessionSaved(session.sessionId);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error("Google Sheets 저장을 확인하지 못했습니다.");
  }

  async function sendLatestSessionToSheets() {
    if (!latestSession) return;
    if (!getSheetsEndpoint()) {
      ui.sheetsUploadStatus.textContent = "Apps Script URL이 script.js 코드에 설정되지 않아 이 기기에만 저장했습니다. 코드의 SHEETS_WEB_APP_URL을 입력한 뒤 다시 전송해 주세요.";
      return;
    }
    ui.sendSheetsAgain.disabled = true;
    ui.sheetsUploadStatus.textContent = "Google Sheets로 결과와 시계열 좌표를 전송하고 있습니다…";
    try {
      await postSessionToSheets(latestSession);
      ui.sheetsUploadStatus.textContent = "Google Sheets 저장 확인 완료! Sessions, Phases, Samples 탭에 기록했습니다.";
    } catch (error) {
      console.error("Google Sheets 전송 오류:", error);
      ui.sheetsUploadStatus.textContent = `전송 요청을 보내지 못했습니다: ${error.message || error}. 인터넷 연결과 /exec 주소를 확인해 주세요.`;
    } finally {
      ui.sendSheetsAgain.disabled = false;
    }
  }

  function finish() {
    if (!running) return;
    running = false;
    cancelAnimationFrame(raf);

    const overall = analyze(samples);
    const phases = ["초반", "중반", "후반"].map((name) => {
      const subset = samples.filter((sample) => sample.phase === name);
      return { name, ...analyze(subset) };
    });
    latestSession = {
      sessionId: (window.crypto && typeof crypto.randomUUID === "function")
        ? crypto.randomUUID()
        : `FL-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      date: new Date().toISOString(),
      participant: ui.code.value.trim().slice(0, 30),
      mode,
      duration: DURATION,
      moveSeconds: MOVE_SECONDS,
      thresholdPx: thresholdPx(),
      overall,
      phases,
      samples
    };

    try {
      const sessions = getHistory();
      sessions.unshift(latestSession);
      // Keep full 10 Hz time series for the latest 10 sessions to limit local storage use.
      localStorage.setItem(HISTORY_KEY, JSON.stringify(sessions.slice(0, 10)));
    } catch (error) {
      console.warn("결과를 이 기기에 저장하지 못했습니다.", error);
      alert("결과 화면은 표시되지만 저장 공간이 부족해 기기에 기록하지 못했어요. CSV를 바로 저장해 주세요.");
    }

    render(latestSession);
    view(ui.results);
    ui.status.textContent = "테스트 완료";
    if (mode === "combined") void stopWebGazer();
    void sendLatestSessionToSheets();
  }

  function metricCard(label, value, caption) {
    const card = document.createElement("div");
    card.className = "metric";
    const note = document.createElement("span");
    note.className = "caption";
    note.textContent = `${label} · ${caption}`;
    const strong = document.createElement("strong");
    strong.className = "value";
    strong.textContent = value;
    card.append(note, strong);
    return card;
  }

  function render(session) {
    const combined = session.mode === "combined";
    ui.summary.textContent = `${combined ? "마우스/터치 + 시선 동시 기록" : "마우스/터치만 기록"} · 60초 · ${new Date(session.date).toLocaleString()}`;
    ui.metrics.replaceChildren();
    ui.metrics.append(
      metricCard("포인터 목표 근접률", session.overall.pointer.score == null ? "자료 부족" : `${session.overall.pointer.score}%`, `${session.overall.pointer.n}개 표본 · 입력 기록 범위 ${session.overall.pointer.coverage}%`),
      metricCard("시선 목표 근접률", session.overall.gaze.score == null ? "미기록" : `${session.overall.gaze.score}%`, `${session.overall.gaze.n}개 표본 · 시선 기록 범위 ${session.overall.gaze.coverage}%`),
      metricCard("포인터만 목표 근접", session.overall.comparison.pointerOnGazeOffPercent == null ? "자료 부족" : `${session.overall.comparison.pointerOnGazeOffPercent}%`, "포인터가 목표 안일 때 시선은 목표 밖이었던 비율"),
      metricCard("동시 목표 근접", session.overall.comparison.bothOnPercent == null ? "자료 부족" : `${session.overall.comparison.bothOnPercent}%`, "포인터와 시선이 같은 표본에서 모두 목표 안에 든 비율")
    );

    ui.phaseResults.replaceChildren();
    session.phases.forEach((phase) => {
      const card = document.createElement("div");
      card.className = "phase-card";
      const title = document.createElement("strong");
      title.className = "phase-title";
      title.textContent = phase.name;
      card.append(title);
      card.append(makePhaseLine("포인터", phase.pointer.score));
      card.append(makePhaseLine("시선", phase.gaze.score));
      const compare = document.createElement("p");
      compare.className = "phase-note";
      compare.textContent = phase.comparison.pointerOnGazeOffPercent == null
        ? "포인터·시선 동시 표본이 부족합니다."
        : `포인터가 목표 안일 때 시선이 목표 밖이었던 비율: ${phase.comparison.pointerOnGazeOffPercent}%`;
      card.append(compare);
      ui.phaseResults.append(card);
    });
    renderHistory();
  }

  function makePhaseLine(label, value) {
    const row = document.createElement("div");
    row.className = "phase-line";
    const name = document.createElement("span");
    name.textContent = label;
    const bar = document.createElement("div");
    bar.className = "bar";
    const fill = document.createElement("span");
    fill.style.width = `${value ?? 0}%`;
    if (label === "시선") fill.classList.add("bar-gaze");
    bar.append(fill);
    const score = document.createElement("strong");
    score.textContent = value == null ? "자료 부족" : `${value}%`;
    row.append(name, bar, score);
    return row;
  }

  function renderHistory() {
    ui.history.replaceChildren();
    const history = getHistory();
    if (!history.length) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 5;
      cell.textContent = "아직 기록이 없습니다.";
      row.append(cell);
      ui.history.append(row);
      return;
    }
    history.slice(0, 10).forEach((session) => {
      const row = document.createElement("tr");
      const pointer = session.overall?.pointer?.score;
      const gaze = session.overall?.gaze?.score;
      const split = session.overall?.comparison?.pointerOnGazeOffPercent;
      const values = [
        new Date(session.date).toLocaleString(),
        session.mode === "combined" ? "포인터+시선" : "포인터만",
        pointer == null ? "—" : `${pointer}%`,
        gaze == null ? "—" : `${gaze}%`,
        split == null ? "—" : `${split}%`
      ];
      values.forEach((value) => {
        const cell = document.createElement("td");
        cell.textContent = value;
        row.append(cell);
      });
      ui.history.append(row);
    });
  }

  function csvCell(value) {
    return `"${String(value ?? "").replaceAll('"', '""')}"`;
  }

  function downloadCsv() {
    if (!latestSession) return;
    const s = latestSession;
    const summaryRows = [
      ["FOCUS LAB SUMMARY"],
      ["date", "participant_code", "recording_mode", "duration_seconds", "threshold_px", "pointer_score_percent", "pointer_valid_samples", "pointer_coverage_percent", "gaze_score_percent", "gaze_valid_samples", "gaze_coverage_percent", "pointer_on_target_gaze_off_percent", "both_on_target_percent", "mean_pointer_gaze_gap_px"],
      [s.date, s.participant, s.mode, s.duration, s.thresholdPx,
        s.overall.pointer.score ?? "", s.overall.pointer.n, s.overall.pointer.coverage,
        s.overall.gaze.score ?? "", s.overall.gaze.n, s.overall.gaze.coverage,
        s.overall.comparison.pointerOnGazeOffPercent ?? "", s.overall.comparison.bothOnPercent ?? "", s.overall.comparison.meanGapPx ?? ""],
      [],
      ["PHASE SUMMARY"],
      ["phase", "pointer_score_percent", "gaze_score_percent", "pointer_on_target_gaze_off_percent", "valid_pointer_samples", "valid_gaze_samples", "paired_samples"],
      ...s.phases.map((p) => [p.name, p.pointer.score ?? "", p.gaze.score ?? "", p.comparison.pointerOnGazeOffPercent ?? "", p.pointer.n, p.gaze.n, p.comparison.validPairs]),
      [],
      ["TIME SERIES (10 samples/sec)"],
      ["elapsed_seconds", "phase", "target_x_norm", "target_y_norm", "pointer_x_norm", "pointer_y_norm", "pointer_distance_px", "pointer_on_target", "gaze_x_norm_hidden", "gaze_y_norm_hidden", "gaze_distance_px_hidden", "gaze_on_target_hidden", "pointer_on_target_gaze_off"]
    ];
    const limit = s.thresholdPx;
    const seriesRows = s.samples.map((sample) => {
      const pDist = sample.pointerDistancePx ?? null;
      const gDist = sample.gazeDistancePx ?? null;
      const pOn = pDist == null ? "" : pDist <= limit;
      const gOn = gDist == null ? "" : gDist <= limit;
      const split = sample.pointer && sample.gaze ? (pOn === true && gOn === false) : "";
      return [sample.t, sample.phase, sample.target.x, sample.target.y,
        sample.pointer?.x ?? "", sample.pointer?.y ?? "", pDist == null ? "" : pDist.toFixed(1), pOn,
        sample.gaze?.x ?? "", sample.gaze?.y ?? "", gDist == null ? "" : gDist.toFixed(1), gOn, split];
    });
    const csv = "\ufeff" + [...summaryRows, ...seriesRows].map((row) => row.map(csvCell).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `focus-lab-dual-${s.date.slice(0, 10)}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  ui.startMouse.addEventListener("click", () => {
    calibrating = false;
    void stopWebGazer();
    beginGame("mouse");
  });
  ui.startEye.addEventListener("click", startEye);
  ui.cancel.addEventListener("click", () => {
    calibrating = false;
    void stopWebGazer();
    view(ui.intro);
    ui.status.textContent = "대기 중";
  });
  ui.stop.addEventListener("click", finish);
  ui.again.addEventListener("click", () => {
    void stopWebGazer();
    view(ui.intro);
    ui.status.textContent = "대기 중";
  });
  ui.csv.addEventListener("click", downloadCsv);
  ui.testSheetsConnection.addEventListener("click", testSheetsConnection);
  ui.sendSheetsAgain.addEventListener("click", sendLatestSessionToSheets);
  ui.clear.addEventListener("click", () => {
    if (confirm("이 기기의 기록을 삭제할까요?")) {
      localStorage.removeItem(HISTORY_KEY);
      renderHistory();
    }
  });

  updateSheetsStatus();
  renderHistory();
})();
