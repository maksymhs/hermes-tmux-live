/**
 * tmux-live -- Hermes dashboard plugin.
 *
 * Picker of the tmux panes on the machine running the dashboard, plus a
 * larger colour view of one pane, optional keyboard input (send-keys) and
 * process/pane/session termination.
 *
 * Data comes from /api/plugins/tmux-live/{panes,capture,send,kill}; the screen
 * is polled once a second and ANSI SGR sequences are rendered to HTML here.
 */
(function () {
  "use strict";

  const SDK = window.__HERMES_PLUGIN_SDK__;
  if (!SDK) return;

  const { React } = SDK;
  const h = React.createElement;
  const { Card, CardContent, Badge, Button, Input, Select, SelectOption } = SDK.components;
  const { useState, useEffect, useRef, useCallback, useMemo } = SDK.hooks;

  const API = "/api/plugins/tmux-live";
  const STORE_LINES = "tmux-live:lines";

  const SPANISH = ((navigator.language || "en").toLowerCase().indexOf("es") === 0);

  const TEXT = {
    es: {
      live: (count) => count + (count === 1 ? " panel en vivo" : " paneles en vivo"),
      noServer: "no hay servidor tmux activo",
      noConn: "sin conexión con el servidor",
      refresh: "Actualizar",
      waiting: "en espera",
      error: "error",
      emptyHost: "No hay sesiones tmux en este host.",
      emptyServer: "El servidor tmux no está corriendo.",
      open: "Abrir terminal →",
      gridHint: "Elige un panel para verlo en grande, con color y teclado.",
      back: "← Paneles",
      lines: (value) => value + " líneas",
      following: "Siguiendo",
      follow: "Seguir",
      typeOn: "Escribir: sí",
      typeOff: "Escribir: no",
      fullscreen: "Pantalla completa",
      focusHint: "Haz clic en la terminal para escribir",
      typingHint: "Teclado activo — escribe sobre la terminal",
      placeholder: "Mensaje al panel… (⏎ envía)",
      send: "Enviar",
      terminate: "Terminar",
      killProcess: "Matar proceso",
      closePane: "Cerrar panel",
      killSession: "Matar sesión",
      askProcess: "¿Terminar el proceso de ",
      askPane: "¿Cerrar el panel ",
      askSession: "¿Matar la sesión ",
      term: "Terminar (TERM)",
      force: "Forzar (KILL)",
      confirm: "Sí, continuar",
      cancel: "Cancelar",
      noteProcess: "Si es el agente, se detiene la sesión de Hermes que corre ahí.",
      notePane: "Se cierra el panel y su proceso.",
      noteSession: "Se cierran todos los paneles de la sesión.",
      footer:
        "Se refresca cada segundo · los colores son los del panel · «Escribir» envía tus teclas al panel real",
      captureError: "no se pudo leer el panel",
      sendError: "no se pudo enviar",
      killError: "no se pudo terminar el proceso",
      active: "activo",
    },
    en: {
      live: (count) => count + (count === 1 ? " live pane" : " live panes"),
      noServer: "no tmux server running",
      noConn: "cannot reach the server",
      refresh: "Refresh",
      waiting: "waiting",
      error: "error",
      emptyHost: "No tmux sessions on this host.",
      emptyServer: "The tmux server is not running.",
      open: "Open terminal →",
      gridHint: "Pick a pane to see it large, in colour, with keyboard input.",
      back: "← Panes",
      lines: (value) => value + " lines",
      following: "Following",
      follow: "Follow",
      typeOn: "Type: on",
      typeOff: "Type: off",
      fullscreen: "Fullscreen",
      focusHint: "Click the terminal to type",
      typingHint: "Keyboard active — type into the terminal",
      placeholder: "Message to the pane… (⏎ sends)",
      send: "Send",
      terminate: "Terminate",
      killProcess: "Kill process",
      closePane: "Close pane",
      killSession: "Kill session",
      askProcess: "Terminate the process of ",
      askPane: "Close the pane ",
      askSession: "Kill the session ",
      term: "Terminate (TERM)",
      force: "Force (KILL)",
      confirm: "Yes, continue",
      cancel: "Cancel",
      noteProcess: "If this is the agent, the Hermes session running there stops.",
      notePane: "The pane and its process are closed.",
      noteSession: "Every pane in the session is closed.",
      footer:
        "Refreshes every second · colours come from the pane · «Type» sends your keys to the real pane",
      captureError: "cannot read the pane",
      sendError: "could not send",
      killError: "could not terminate the process",
      active: "active",
    },
  };

  const T = SPANISH ? TEXT.es : TEXT.en;

  const BASE_COLORS = [
    "#1b1d23", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#dcdfe4",
    "#5c6370", "#ff7b86", "#b5e890", "#ffd68a", "#82c4ff", "#e0a0ff", "#7fe3ef", "#ffffff",
  ];

  const QUICK_KEYS = [
    ["⏎", "Enter"],
    ["Esc", "Escape"],
    ["Tab", "Tab"],
    ["^C", "C-c"],
    ["↑", "Up"],
    ["↓", "Down"],
  ];

  function readStore(key, fallback) {
    try {
      const value = window.localStorage.getItem(key);
      return value === null ? fallback : value;
    } catch (err) {
      return fallback;
    }
  }

  function writeStore(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch (err) {
      /* private mode, ignore */
    }
  }

  /* ------------------------------------------------------------------ *
   * ANSI -> HTML
   * ------------------------------------------------------------------ */

  function escapeHtml(value) {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function color256(index) {
    if (index < 16) return BASE_COLORS[index] || BASE_COLORS[7];
    if (index < 232) {
      const n = index - 16;
      const steps = [0, 95, 135, 175, 215, 255];
      const r = steps[Math.floor(n / 36) % 6];
      const g = steps[Math.floor(n / 6) % 6];
      const b = steps[n % 6];
      return "rgb(" + r + "," + g + "," + b + ")";
    }
    const grey = 8 + (index - 232) * 10;
    return "rgb(" + grey + "," + grey + "," + grey + ")";
  }

  function newSgr() {
    return {
      fg: null,
      bg: null,
      bold: false,
      dim: false,
      italic: false,
      underline: false,
      strike: false,
      reverse: false,
      hidden: false,
    };
  }

  function applySgr(state, params) {
    if (!params) return newSgr();
    const codes = params.split(";").map((part) => (part === "" ? 0 : parseInt(part, 10)));
    for (let i = 0; i < codes.length; i += 1) {
      const code = Number.isFinite(codes[i]) ? codes[i] : 0;
      if (code === 0) state = newSgr();
      else if (code === 1) state.bold = true;
      else if (code === 2) state.dim = true;
      else if (code === 3) state.italic = true;
      else if (code === 4) state.underline = true;
      else if (code === 7) state.reverse = true;
      else if (code === 8) state.hidden = true;
      else if (code === 9) state.strike = true;
      else if (code === 22) (state.bold = false), (state.dim = false);
      else if (code === 23) state.italic = false;
      else if (code === 24) state.underline = false;
      else if (code === 27) state.reverse = false;
      else if (code === 28) state.hidden = false;
      else if (code === 29) state.strike = false;
      else if (code === 39) state.fg = null;
      else if (code === 49) state.bg = null;
      else if (code >= 30 && code <= 37) state.fg = BASE_COLORS[code - 30];
      else if (code >= 90 && code <= 97) state.fg = BASE_COLORS[code - 90 + 8];
      else if (code >= 40 && code <= 47) state.bg = BASE_COLORS[code - 40];
      else if (code >= 100 && code <= 107) state.bg = BASE_COLORS[code - 100 + 8];
      else if (code === 38 || code === 48) {
        const target = code === 38 ? "fg" : "bg";
        if (codes[i + 1] === 5) {
          state[target] = color256(codes[i + 2]);
          i += 2;
        } else if (codes[i + 1] === 2) {
          state[target] = "rgb(" + codes[i + 2] + "," + codes[i + 3] + "," + codes[i + 4] + ")";
          i += 4;
        }
      }
    }
    return state;
  }

  function spanFor(state, text) {
    if (!text) return "";
    let fg = state.fg;
    let bg = state.bg;
    if (state.reverse) {
      const previous = fg;
      fg = bg || "#0d1014";
      bg = previous || "#dcdfe4";
    }
    const css = [];
    if (state.hidden) {
      fg = bg || "#0d1014";
    }
    if (fg) css.push("color:" + fg);
    if (bg) css.push("background:" + bg);
    if (state.bold) css.push("font-weight:600");
    if (state.dim) css.push("opacity:.6");
    if (state.italic) css.push("font-style:italic");
    const decoration = [];
    if (state.underline) decoration.push("underline");
    if (state.strike) decoration.push("line-through");
    if (decoration.length) css.push("text-decoration:" + decoration.join(" "));
    const body = escapeHtml(text);
    return css.length ? '<span style="' + css.join(";") + '">' + body + "</span>" : body;
  }

  function ansiToHtml(raw) {
    if (!raw) return "";
    const cleaned = raw
      .replace(/\r/g, "")
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
      .replace(/\x1b\[[0-9;?]*[A-Za-ln-z]/g, "");
    const matcher = /\x1b\[([0-9;]*)m/g;
    let state = newSgr();
    let out = "";
    let last = 0;
    let match = matcher.exec(cleaned);
    while (match) {
      out += spanFor(state, cleaned.slice(last, match.index));
      state = applySgr(state, match[1]);
      last = match.index + match[0].length;
      match = matcher.exec(cleaned);
    }
    out += spanFor(state, cleaned.slice(last));
    return out;
  }

  /* ------------------------------------------------------------------ *
   * Helpers
   * ------------------------------------------------------------------ */

  function usePoll(callback, ms) {
    const saved = useRef(callback);
    saved.current = callback;
    useEffect(() => {
      let alive = true;
      let timer = null;
      const tick = async () => {
        if (!alive) return;
        if (!document.hidden) {
          try {
            await saved.current();
          } catch (err) {
            /* the callback renders its own error state */
          }
        }
        if (alive) timer = window.setTimeout(tick, ms);
      };
      tick();
      return () => {
        alive = false;
        if (timer) window.clearTimeout(timer);
      };
    }, [ms]);
  }

  function Dot(props) {
    return h("span", {
      className: "tmux-live-dot" + (props.on ? " is-on" : ""),
      "aria-hidden": "true",
    });
  }

  function shortPath(path) {
    return path ? path.replace(/^\/home\/[^/]+/, "~") : "";
  }

  /* ------------------------------------------------------------------ *
   * Page
   * ------------------------------------------------------------------ */

  function TmuxPage() {
    const [view, setView] = useState("grid");
    const [panes, setPanes] = useState([]);
    const [serverRunning, setServerRunning] = useState(true);
    const [gridError, setGridError] = useState(null);
    const [gridUpdated, setGridUpdated] = useState(0);

    const [target, setTarget] = useState("");
    const [text, setText] = useState("");
    const [hash, setHash] = useState("");
    const [meta, setMeta] = useState(null);
    const [detailError, setDetailError] = useState(null);
    const [follow, setFollow] = useState(true);
    const [lines, setLines] = useState(() => readStore(STORE_LINES, "400"));
    const [updated, setUpdated] = useState(0);

    const [typing, setTyping] = useState(false);
    const [focused, setFocused] = useState(false);
    const [message, setMessage] = useState("");
    const [sendError, setSendError] = useState(null);
    const [sending, setSending] = useState(false);
    const [pendingKill, setPendingKill] = useState(null);
    const [killError, setKillError] = useState(null);
    const [killing, setKilling] = useState(false);

    const viewRef = useRef(view);
    viewRef.current = view;
    const targetRef = useRef(target);
    targetRef.current = target;
    const hashRef = useRef(hash);
    hashRef.current = hash;
    const followRef = useRef(follow);
    followRef.current = follow;

    const screenRef = useRef(null);
    const detailRef = useRef(null);
    const scrollRef = useRef(0);
    const bufferRef = useRef("");
    const flushTimer = useRef(null);

    const loadPanes = useCallback(async () => {
      try {
        const data = await SDK.fetchJSON(API + "/panes");
        setGridError(null);
        setServerRunning(Boolean(data.server_running));
        setPanes(Array.isArray(data.panes) ? data.panes : []);
        setGridUpdated(Date.now());
      } catch (err) {
        setGridError(err && err.message ? err.message : T.noConn);
      }
    }, []);

    const loadCapture = useCallback(async () => {
      const current = targetRef.current;
      if (!current) return;
      const query =
        API +
        "/capture?target=" +
        encodeURIComponent(current) +
        "&lines=" +
        encodeURIComponent(lines) +
        "&ansi=1";
      try {
        const data = await SDK.fetchJSON(query);
        setDetailError(null);
        if (data.hash !== hashRef.current) {
          setHash(data.hash);
          setText(data.text || "");
          setUpdated(Date.now());
        }
        setMeta(data);
      } catch (err) {
        setDetailError(err && err.message ? err.message : T.captureError);
      }
    }, [lines]);

    usePoll(
      useCallback(async () => {
        if (viewRef.current !== "grid") return;
        await loadPanes();
      }, [loadPanes]),
      3000,
    );

    usePoll(
      useCallback(async () => {
        if (viewRef.current !== "detail") return;
        await loadCapture();
      }, [loadCapture]),
      1000,
    );

    useEffect(() => {
      writeStore(STORE_LINES, lines);
    }, [lines]);

    const html = useMemo(() => ansiToHtml(text), [text]);

    useEffect(() => {
      const node = screenRef.current;
      if (!node) return;
      if (follow) node.scrollTop = node.scrollHeight;
      else node.scrollTop = scrollRef.current;
    }, [html, follow]);

    const send = useCallback(async (payload) => {
      const current = targetRef.current;
      if (!current) return false;
      try {
        await SDK.fetchJSON(API + "/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ target: current, ...payload }),
        });
        setSendError(null);
        return true;
      } catch (err) {
        setSendError(err && err.message ? err.message : T.sendError);
        return false;
      }
    }, []);

    const flushText = useCallback(() => {
      const buffered = bufferRef.current;
      bufferRef.current = "";
      if (flushTimer.current) {
        window.clearTimeout(flushTimer.current);
        flushTimer.current = null;
      }
      if (buffered) send({ text: buffered });
    }, [send]);

    const openPane = useCallback((item) => {
      setTarget(item.target);
      setText("");
      setHash("");
      setMeta(null);
      setDetailError(null);
      setFollow(true);
      setTyping(false);
      setMessage("");
      setSendError(null);
      setPendingKill(null);
      setKillError(null);
      scrollRef.current = 0;
      setView("detail");
    }, []);

    const backToGrid = useCallback(() => {
      flushText();
      setTyping(false);
      setView("grid");
      loadPanes();
    }, [flushText, loadPanes]);

    const submitMessage = useCallback(async () => {
      const value = message;
      if (!value.trim()) return;
      setMessage("");
      setSending(true);
      const ok = await send({ text: value });
      if (ok) await send({ key: "Enter" });
      setSending(false);
    }, [message, send]);

    const runKill = useCallback(
      async (mode, sig) => {
        const current = targetRef.current;
        if (!current) return;
        setKilling(true);
        setKillError(null);
        try {
          await SDK.fetchJSON(API + "/kill", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ target: current, mode: mode, signal: sig || "TERM" }),
          });
          setKilling(false);
          setPendingKill(null);
          setTyping(false);
          setView("grid");
          window.setTimeout(() => loadPanes(), 500);
        } catch (err) {
          setKilling(false);
          setKillError(err && err.message ? err.message : T.killError);
        }
      },
      [loadPanes],
    );

    const onScreenKeyDown = useCallback(
      (event) => {
        if (!typing) return;
        if (event.metaKey || event.altKey) return;
        if (event.ctrlKey) {
          const map = {
            a: "C-a",
            c: "C-c",
            d: "C-d",
            e: "C-e",
            k: "C-k",
            l: "C-l",
            r: "C-r",
            u: "C-u",
            z: "C-z",
          };
          const key = map[event.key.toLowerCase()];
          if (key) {
            event.preventDefault();
            flushText();
            send({ key: key });
          }
          return;
        }
        if (event.key === "Enter") {
          event.preventDefault();
          flushText();
          send({ key: "Enter" });
          return;
        }
        if (event.key === "Backspace") {
          event.preventDefault();
          flushText();
          send({ key: "BSpace" });
          return;
        }
        if (event.key === "Tab") {
          event.preventDefault();
          flushText();
          send({ key: event.shiftKey ? "BTab" : "Tab" });
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          flushText();
          send({ key: "Escape" });
          return;
        }
        const arrows = {
          ArrowUp: "Up",
          ArrowDown: "Down",
          ArrowLeft: "Left",
          ArrowRight: "Right",
          Home: "Home",
          End: "End",
          PageUp: "PageUp",
          PageDown: "PageDown",
        };
        if (arrows[event.key]) {
          event.preventDefault();
          flushText();
          send({ key: arrows[event.key] });
          return;
        }
        if (event.key.length === 1) {
          event.preventDefault();
          bufferRef.current += event.key;
          if (!flushTimer.current) flushTimer.current = window.setTimeout(flushText, 80);
        }
      },
      [typing, flushText, send],
    );

    const onScreenPaste = useCallback(
      (event) => {
        if (!typing) return;
        event.preventDefault();
        const pasted = (event.clipboardData || window.clipboardData).getData("text");
        if (pasted) send({ text: pasted.replace(/\s+/g, " ").trim() });
      },
      [typing, send],
    );

    const toggleFullscreen = useCallback(() => {
      const node = detailRef.current;
      if (!node) return;
      if (document.fullscreenElement) {
        document.exitFullscreen();
      } else if (node.requestFullscreen) {
        node.requestFullscreen().catch(() => undefined);
      }
    }, []);

    /* ---------------------------------------------------------------- *
     * Grid
     * ---------------------------------------------------------------- */

    const grid =
      view !== "grid"
        ? null
        : h(
            "div",
            { className: "tmux-live" },
            h(
              "div",
              { className: "tmux-live-bar" },
              h(
                "div",
                { className: "tmux-live-title" },
                h("span", { className: "tmux-live-brand" }, "tmux"),
                h(
                  "span",
                  { className: "tmux-live-sub" },
                  gridError
                    ? T.noConn
                    : serverRunning
                      ? T.live(panes.length)
                      : T.noServer,
                ),
              ),
              h(
                "div",
                { className: "tmux-live-actions" },
                h(
                  "span",
                  { className: "tmux-live-live" },
                  h(Dot, { on: !gridError && serverRunning && panes.length > 0 }),
                  gridUpdated ? new Date(gridUpdated).toLocaleTimeString() : T.waiting,
                ),
                h(Button, { size: "sm", outlined: true, onClick: () => loadPanes() }, T.refresh),
              ),
            ),

            gridError
              ? h("div", { className: "tmux-live-error" }, gridError)
              : panes.length === 0
                ? h(
                    "div",
                    { className: "tmux-live-empty" },
                    serverRunning ? T.emptyHost : T.emptyServer,
                    h("code", null, "tmux new -s demo"),
                  )
                : h(
                    "div",
                    { className: "tmux-live-grid" },
                    panes.map((item) =>
                      h(
                        "button",
                        {
                          key: item.target,
                          type: "button",
                          className: "tmux-live-card",
                          onClick: () => openPane(item),
                        },
                        h(
                          "span",
                          { className: "tmux-live-card-head" },
                          h(
                            "span",
                            { className: "tmux-live-card-name" },
                            h(Dot, { on: item.attached }),
                            item.target,
                          ),
                          item.active ? h(Badge, { className: "tmux-live-badge" }, T.active) : null,
                        ),
                        h("span", { className: "tmux-live-card-meta" }, (item.command || "?") + " · " + item.size),
                        h("span", { className: "tmux-live-card-path" }, shortPath(item.path)),
                        h("span", { className: "tmux-live-card-open" }, T.open),
                      ),
                    ),
                  ),
            h("p", { className: "tmux-live-foot" }, T.gridHint),
          );

    /* ---------------------------------------------------------------- *
     * Detail
     * ---------------------------------------------------------------- */

    const detail =
      view !== "detail"
        ? null
        : h(
            "div",
            { className: "tmux-live tmux-live-detail", ref: detailRef },
            h(
              "div",
              { className: "tmux-live-bar" },
              h(
                "div",
                { className: "tmux-live-title" },
                h(Button, { size: "sm", outlined: true, onClick: backToGrid }, T.back),
                h("code", { className: "tmux-live-target" }, target),
                h(
                  "span",
                  { className: "tmux-live-sub" },
                  meta ? (meta.command || "") + " · " + (meta.columns || 0) + "x" + (meta.rows || 0) : "",
                ),
              ),
              h(
                "div",
                { className: "tmux-live-actions" },
                h(
                  "span",
                  { className: "tmux-live-live" },
                  h(Dot, { on: !detailError }),
                  detailError ? T.error : updated ? new Date(updated).toLocaleTimeString() : "…",
                ),
                h(
                  Select,
                  { value: lines, onValueChange: (value) => setLines(value) },
                  h(SelectOption, { value: "120" }, T.lines(120)),
                  h(SelectOption, { value: "400" }, T.lines(400)),
                  h(SelectOption, { value: "800" }, T.lines(800)),
                  h(SelectOption, { value: "2000" }, T.lines(2000)),
                ),
                h(
                  Button,
                  { size: "sm", outlined: !follow, onClick: () => setFollow((value) => !value) },
                  follow ? T.following : T.follow,
                ),
                h(
                  Button,
                  { size: "sm", outlined: !typing, onClick: () => setTyping((value) => !value) },
                  typing ? T.typeOn : T.typeOff,
                ),
                h(Button, { size: "sm", outlined: true, onClick: toggleFullscreen }, T.fullscreen),
              ),
            ),

            h(
              "div",
              { className: "tmux-live-screen-wrap" },
              detailError
                ? h("div", { className: "tmux-live-error" }, detailError)
                : h("pre", {
                    ref: screenRef,
                    className: "tmux-live-screen" + (typing ? " is-typing" : ""),
                    tabIndex: 0,
                    spellCheck: false,
                    onKeyDown: onScreenKeyDown,
                    onPaste: onScreenPaste,
                    onFocus: () => setFocused(true),
                    onBlur: () => setFocused(false),
                    onScroll: (event) => {
                      scrollRef.current = event.currentTarget.scrollTop;
                    },
                    dangerouslySetInnerHTML: { __html: html || "" },
                  }),
              typing
                ? h("span", { className: "tmux-live-keyhint" }, focused ? T.typingHint : T.focusHint)
                : null,
            ),

            h(
              "div",
              { className: "tmux-live-send" },
              h(Input, {
                value: message,
                placeholder: T.placeholder,
                onChange: (event) => setMessage(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    submitMessage();
                  }
                },
              }),
              h(
                Button,
                { size: "sm", onClick: submitMessage, disabled: sending || !message.trim() },
                T.send,
              ),
              h(
                "span",
                { className: "tmux-live-quick" },
                QUICK_KEYS.map((pair) =>
                  h(
                    Button,
                    {
                      key: pair[1],
                      size: "sm",
                      outlined: true,
                      onClick: () => send({ key: pair[1] }),
                      title: pair[1],
                    },
                    pair[0],
                  ),
                ),
              ),
            ),

            h(
              "div",
              { className: "tmux-live-danger" },
              h("span", { className: "tmux-live-danger-label" }, T.terminate),
              h(
                Button,
                {
                  size: "sm",
                  outlined: true,
                  onClick: () => {
                    setKillError(null);
                    setPendingKill("process");
                  },
                },
                T.killProcess,
              ),
              h(
                Button,
                {
                  size: "sm",
                  outlined: true,
                  onClick: () => {
                    setKillError(null);
                    setPendingKill("pane");
                  },
                },
                T.closePane,
              ),
              h(
                Button,
                {
                  size: "sm",
                  outlined: true,
                  onClick: () => {
                    setKillError(null);
                    setPendingKill("session");
                  },
                },
                T.killSession,
              ),
            ),

            pendingKill
              ? h(
                  "div",
                  { className: "tmux-live-confirm" },
                  h(
                    "span",
                    { className: "tmux-live-confirm-text" },
                    pendingKill === "process"
                      ? T.askProcess
                      : pendingKill === "pane"
                        ? T.askPane
                        : T.askSession,
                    h("code", null, pendingKill === "session" ? target.split(":")[0] : target),
                    "?",
                  ),
                  pendingKill === "process"
                    ? h(
                        React.Fragment,
                        null,
                        h(
                          Button,
                          { size: "sm", onClick: () => runKill("process", "TERM"), disabled: killing },
                          T.term,
                        ),
                        h(
                          Button,
                          { size: "sm", outlined: true, onClick: () => runKill("process", "KILL"), disabled: killing },
                          T.force,
                        ),
                      )
                    : h(
                        Button,
                        { size: "sm", onClick: () => runKill(pendingKill), disabled: killing },
                        T.confirm,
                      ),
                  h(
                    Button,
                    { size: "sm", outlined: true, onClick: () => setPendingKill(null), disabled: killing },
                    T.cancel,
                  ),
                  h(
                    "span",
                    { className: "tmux-live-confirm-note" },
                    pendingKill === "process"
                      ? T.noteProcess
                      : pendingKill === "pane"
                        ? T.notePane
                        : T.noteSession,
                  ),
                )
              : null,

            killError ? h("div", { className: "tmux-live-error tmux-live-send-error" }, killError) : null,
            sendError ? h("div", { className: "tmux-live-error tmux-live-send-error" }, sendError) : null,

            h("p", { className: "tmux-live-foot" }, T.footer),
          );

    return h("div", { className: "tmux-live-root" }, grid, detail);
  }

  window.__HERMES_PLUGINS__.register("tmux-live", TmuxPage);
})();
