/**
 * dsh-session-retitle —— 客户端（浏览器侧）
 *
 * 只在会话头部动作区（conversation.session.header.actions）挂一个「重命名」按钮：
 *   点开 → 小气泡里可以留空（按会话内容自动起名）或直接填一个名字 → 确认。
 *   后端一次调用完成「读会话内容 → 模型起名 → 写回会话名」。
 *
 * 为什么这么薄：客户端插件 API（插槽 + React 运行时）是整套方案里最容易被 DSH
 * 升级打断的一层。逻辑全在 host 侧，这里最坏情况只是按钮消失，不会拖垮 GUI，
 * 也不会影响会话本体（改名走官方 sessionTitle 服务，与本插件无关）。
 *
 * 明暗主题跟随（三层保险，2026-09-16 修）：
 *   ① 主：DSH 自己的 CSS 变量 `--dsw-alias-*`（值随主题切换，浏览器自动重绘，零 JS）；
 *   ② 若这些变量不存在（DSH 以后改名）：用 detectTheme() 读到的明暗，落到自带色板（内联样式）；
 *   ③ 兜底：CSS 系统色 `Canvas`/`CanvasText`，至少不会白底白字。
 *   踩过的坑：最初写成 `--dsh-bg-elevated`（DSH 里根本没有这个变量），`#fff` 兜底生效，
 *   于是暗色主题下面板是白底白字。
 */
window.__ModuleLoader__.load({
	id: "dsh-session-retitle",
	factory: (require) => {
		var module = { exports: {} };
		const react = require("react");

		// 与 host 侧 cordis.patch.yml 的 routePrefix 保持一致；需要改时改这里或注入全局覆盖。
		const DEFAULT_PREFIX = "/dsh-session-retitle";
		const prefix = () => {
			try {
				return window.__DSH_SESSION_RETITLE_PREFIX__ || DEFAULT_PREFIX;
			} catch (e) {
				return DEFAULT_PREFIX;
			}
		};

		const STYLE_ID = "dsh-session-retitle-style";

		/** 全部 class 名前缀统一，避免与 DSH 自身样式撞车。 */
		const CLS = {
			trigger: "dsh-retitle-trigger",
			note: "dsh-retitle-note",
			noteOk: "dsh-retitle-note-ok",
			noteBad: "dsh-retitle-note-bad",
			panel: "dsh-retitle-panel",
			hint: "dsh-retitle-hint",
			input: "dsh-retitle-input",
			actions: "dsh-retitle-actions",
			btn: "dsh-retitle-btn",
			btnPrimary: "dsh-retitle-btn-primary",
		};

		/**
		 * 注入的样式表：颜色一律走 DSH 变量 + 系统色兜底，**不写死任何主题色**
		 * （写死就等于放弃跟随主题）。
		 */
		const SHEET = `
.${CLS.trigger} {
  appearance: none;
  background: transparent;
  border: 1px solid var(--dsw-alias-border-l2, currentColor);
  border-radius: 6px;
  color: var(--dsw-alias-label-secondary, CanvasText);
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  line-height: 1.4;
  padding: 2px 8px;
}
.${CLS.trigger}:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.14)); }
.${CLS.trigger}:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, currentColor); outline-offset: 1px; }
.${CLS.trigger}:disabled { cursor: progress; opacity: .7; }

.${CLS.note} {
  font-size: 11px;
  white-space: nowrap;
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--dsw-alias-label-tertiary, CanvasText);
}
.${CLS.noteOk} { color: var(--dsw-alias-state-success-primary, #16a34a); }
.${CLS.noteBad} { color: var(--dsw-alias-state-error-primary, #dc2626); }

.${CLS.panel} {
  position: absolute;
  right: 0;
  top: calc(100% + 6px);
  z-index: 40;
  width: 260px;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  border-radius: 10px;
  text-align: left;
  border: 1px solid var(--dsw-elevation-stroke-color, var(--dsw-alias-border-l1, rgba(127,127,127,.32)));
  background: var(--dsw-specific-menu, var(--dsw-alias-bg-layer-2, Canvas));
  color: var(--dsw-alias-label-primary, CanvasText);
  box-shadow: var(--dsw-elevation-prominent, 0 10px 30px rgba(0,0,0,.18));
}
.${CLS.hint} { font-size: 11px; color: var(--dsw-alias-label-tertiary, CanvasText); }

.${CLS.input} {
  width: 100%;
  box-sizing: border-box;
  padding: 5px 8px;
  border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.38));
  background: var(--dsw-alias-fill-l2, transparent);
  color: inherit;
  font: inherit;
  font-size: 12px;
}
.${CLS.input}::placeholder { color: var(--dsw-alias-label-caption, currentColor); opacity: .8; }

.${CLS.actions} { display: flex; justify-content: flex-end; gap: 6px; }
.${CLS.btn} {
  appearance: none;
  background: transparent;
  border: 1px solid var(--dsw-alias-border-l2, currentColor);
  border-radius: 6px;
  color: var(--dsw-alias-label-primary, CanvasText);
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  padding: 3px 10px;
}
.${CLS.btn}:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.14)); }
.${CLS.btn}:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, currentColor); outline-offset: 1px; }
.${CLS.btn}:disabled { cursor: progress; opacity: .7; }
.${CLS.btnPrimary} { font-weight: 600; }
`

		/** 自带色板：只在 DSH 变量缺失时用（第三层不是它，系统色才是最后兜底）。 */
		const PALETTE = {
			dark: {
				panel: "#1c1c1f", text: "#f9fafb", muted: "#adb2b8", border: "rgba(255,255,255,.16)",
				input: "#202024", hover: "rgba(255,255,255,.10)", shadow: "0 10px 30px rgba(0,0,0,.5)",
				ok: "#3ddc84", bad: "#ff6b6b",
			},
			light: {
				panel: "#ffffff", text: "#0f1115", muted: "#61666b", border: "rgba(0,0,0,.14)",
				input: "#f5f6f7", hover: "rgba(0,0,0,.06)", shadow: "0 10px 30px rgba(0,0,0,.18)",
				ok: "#16a34a", bad: "#dc2626",
			},
		};

		const paletteFor = (name) => (name === "dark" ? PALETTE.dark : PALETTE.light);

		/** 幂等注入样式：按 id 查，已存在就不重复插。 */
		function ensureStylesheet(doc) {
			const target = doc || (typeof document !== "undefined" ? document : null);
			if (!target || typeof target.createElement !== "function") return false;
			try {
				if (typeof target.getElementById === "function" && target.getElementById(STYLE_ID)) return true;
				const el = target.createElement("style");
				el.id = STYLE_ID;
				el.textContent = SHEET;
				const host = target.head || target.documentElement;
				if (!host || typeof host.appendChild !== "function") return false;
				host.appendChild(el);
				return true;
			} catch (e) {
				return false;
			}
		}

		/** 读 DSH 当前明暗：属性 → class → 实际背景亮度 → 系统偏好。 */
		function detectTheme(doc) {
			const target = doc || (typeof document !== "undefined" ? document : null);
			try {
				// DSH 的暗色标记是 data-ds-dark-theme（主样式表里就是这个选择器，可能在 body 也可能在 html）
				const marked = (node) => Boolean(node && typeof node.hasAttribute === "function" && node.hasAttribute("data-ds-dark-theme"));
				if (target && (marked(target.body) || marked(target.documentElement))) return "dark";
				const el = target ? target.documentElement : null;
				if (el && typeof el.getAttribute === "function") {
					const attr = String(el.getAttribute("data-theme") || el.getAttribute("data-color-scheme") || "").toLowerCase();
					if (attr === "dark" || attr === "light") return attr;
					if (el.classList && el.classList.contains("dark")) return "dark";
					if (el.classList && el.classList.contains("light")) return "light";
				}
				const view = target && target.defaultView ? target.defaultView : (typeof window !== "undefined" ? window : null);
				if (view && typeof view.getComputedStyle === "function") {
					const bg = view.getComputedStyle(target.body || el).backgroundColor || "";
					const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
					if (m) {
						const lum = 0.2126 * Number(m[1]) + 0.7152 * Number(m[2]) + 0.0722 * Number(m[3]);
						return lum < 128 ? "dark" : "light";
					}
				}
			} catch (e) {}
			try {
				const view = typeof window !== "undefined" ? window : null;
				return view && view.matchMedia && view.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
			} catch (e) {
				return "light";
			}
		}

		/** DSH 的主题变量在不在？在就交给 CSS 变量（最省事、最跟得上）。 */
		function dswVariablesAvailable(doc) {
			const target = doc || (typeof document !== "undefined" ? document : null);
			try {
				const view = target && target.defaultView ? target.defaultView : (typeof window !== "undefined" ? window : null);
				if (!view || typeof view.getComputedStyle !== "function" || !target) return false;
				const value = view.getComputedStyle(target.documentElement).getPropertyValue("--dsw-alias-label-primary");
				return String(value || "").trim().length > 0;
			} catch (e) {
				return false;
			}
		}

		/** 变量缺失时的内联兜底样式（内联优先级高于 class，正好用来压过 CSS 里的系统色兜底）。 */
		function fallbackStyles(themeName) {
			const p = paletteFor(themeName);
			return {
				trigger: { borderColor: p.border, color: p.muted },
				panel: { background: p.panel, color: p.text, borderColor: p.border, boxShadow: p.shadow },
				hint: { color: p.muted },
				input: { background: p.input, borderColor: p.border, color: p.text },
				btn: { borderColor: p.border, color: p.text },
				ok: { color: p.ok },
				bad: { color: p.bad },
			};
		}

		/** 跟随 DSH 主题：属性变化 / class 变化 / 系统偏好变化，任一触发都重算。 */
		function useTheme(react_) {
			const [state, setState] = react_.useState(() => ({
				theme: detectTheme(),
				varsOk: dswVariablesAvailable(),
			}));
			react_.useEffect(() => {
				const sync = () => {
					const next = { theme: detectTheme(), varsOk: dswVariablesAvailable() };
					setState((prev) => (prev.theme === next.theme && prev.varsOk === next.varsOk ? prev : next));
				};
				sync();
				let observer = null;
				let media = null;
				let timer = null;
				try {
					if (typeof MutationObserver === "function") {
						observer = new MutationObserver(sync);
						observer.observe(document.documentElement, { attributes: true });
						if (document.body) observer.observe(document.body, { attributes: true });
					}
				} catch (e) {}
				try {
					media = window.matchMedia("(prefers-color-scheme: dark)");
					media.addEventListener("change", sync);
				} catch (e) {}
				// 兜底轮询：DSH 将来若改用别的标记，属性观察抓不到
				timer = setInterval(sync, 5000);
				return () => {
					try { observer && observer.disconnect(); } catch (e) {}
					try { media && media.removeEventListener("change", sync); } catch (e) {}
					clearInterval(timer);
				};
			}, []);
			return state;
		}

		/** 调 host 的 /rename：留空 title 表示"按会话内容自动起名"。 */
		async function requestRename(sessionId, title, signal) {
			const response = await fetch(prefix() + "/rename", {
				method: "POST",
				headers: { "content-type": "application/json" },
				credentials: "same-origin",
				body: JSON.stringify(title ? { sessionId, title } : { sessionId }),
				signal,
			});
			let payload = null;
			try {
				payload = await response.json();
			} catch (e) {
				payload = null;
			}
			if (!response.ok || !payload || payload.ok !== true) {
				const message =
					(payload && payload.error && payload.error.message) ||
					"重命名失败：HTTP " + response.status;
				throw new Error(message);
			}
			return payload;
		}

		function RetitleAction(props) {
			const sessionId = (props && props.sessionId) || "";
			const canHook = typeof react.useState === "function" && typeof react.useEffect === "function";
			if (!canHook || !sessionId) return null;

			const [open, setOpen] = react.useState(false);
			const [value, setValue] = react.useState("");
			const [busy, setBusy] = react.useState(false);
			const [note, setNote] = react.useState("");
			const [tone, setTone] = react.useState("");
			const rootRef = react.useRef(null);
			const inputRef = react.useRef(null);
			const abortRef = react.useRef(null);
			const timerRef = react.useRef(null);

			// 主题跟随：DSH 变量优先，缺失时用检测到的明暗落自带色板
			const themeState = useTheme(react);
			const fallback = themeState.varsOk ? null : fallbackStyles(themeState.theme);

			// 点外面/按 Esc 收起气泡；卸载时清掉挂起的请求与定时器
			react.useEffect(() => {
				if (!open) return undefined;
				const onPointerDown = (event) => {
					const root = rootRef.current;
					if (root && event.target instanceof Node && !root.contains(event.target)) setOpen(false);
				};
				const onKeyDown = (event) => {
					if (event.key === "Escape") setOpen(false);
				};
				document.addEventListener("mousedown", onPointerDown, true);
				document.addEventListener("keydown", onKeyDown, true);
				return () => {
					document.removeEventListener("mousedown", onPointerDown, true);
					document.removeEventListener("keydown", onKeyDown, true);
				};
			}, [open]);

			react.useEffect(() => () => {
				try { abortRef.current && abortRef.current.abort(); } catch (e) {}
				try { timerRef.current && clearTimeout(timerRef.current); } catch (e) {}
			}, []);

			react.useEffect(() => {
				if (open && inputRef.current && typeof inputRef.current.focus === "function") {
					try { inputRef.current.focus(); } catch (e) {}
				}
			}, [open]);

			const flash = (text, kind) => {
				setNote(text);
				setTone(kind || "");
				try { timerRef.current && clearTimeout(timerRef.current); } catch (e) {}
				timerRef.current = setTimeout(() => {
					setNote("");
					setTone("");
				}, 4000);
			};

			const submit = async () => {
				if (busy) return;
				const manual = value.trim();
				setBusy(true);
				setNote(manual ? "正在写入标题…" : "正在读会话内容并起名…");
				setTone("");
				let controller = null;
				try {
					controller = new AbortController();
					abortRef.current = controller;
					const result = await requestRename(sessionId, manual, controller.signal);
					flash("已重命名为「" + result.title + "」", "ok");
					setValue("");
					setOpen(false);
				} catch (err) {
					if (err && err.name === "AbortError") return;
					flash(String((err && err.message) || err), "bad");
				} finally {
					setBusy(false);
					abortRef.current = null;
				}
			};

			const onInputKeyDown = (event) => {
				if (event.key === "Enter") {
					event.preventDefault();
					submit();
				}
			};

			const noteClass = [
				CLS.note,
				tone === "ok" ? CLS.noteOk : tone === "bad" ? CLS.noteBad : "",
			].filter(Boolean).join(" ");

			return react.createElement(
				"span",
				{ ref: rootRef, style: { position: "relative", display: "inline-flex", alignItems: "center", gap: "6px" } },
				react.createElement(
					"button",
					{
						type: "button",
						className: CLS.trigger,
						style: fallback ? fallback.trigger : undefined,
						title: "按本会话内容自动起名，也可以自己填一个名字",
						"aria-expanded": open,
						onClick: () => setOpen((current) => !current),
					},
					busy ? "命名中…" : "重命名",
				),
				note
					? react.createElement(
							"span",
							{
								className: noteClass,
								style: fallback ? (tone === "ok" ? fallback.ok : tone === "bad" ? fallback.bad : undefined) : undefined,
								title: note,
							},
							note,
						)
					: null,
				open
					? react.createElement(
							"div",
							{
								className: CLS.panel,
								style: fallback ? { ...fallback.panel, colorScheme: themeState.theme } : { colorScheme: themeState.theme },
								role: "dialog",
								"aria-label": "重命名会话",
							},
							react.createElement("div", { className: CLS.hint, style: fallback ? fallback.hint : undefined }, "留空 = 按会话内容自动起名"),
							react.createElement("input", {
								ref: inputRef,
								className: CLS.input,
								style: fallback ? fallback.input : undefined,
								value,
								placeholder: "也可以直接输入新名字",
								disabled: busy,
								onChange: (event) => setValue(event.target.value),
								onKeyDown: onInputKeyDown,
							}),
							react.createElement(
								"div",
								{ className: CLS.actions },
								react.createElement(
									"button",
									{
										type: "button",
										className: CLS.btn,
										style: fallback ? fallback.btn : undefined,
										disabled: busy,
										onClick: () => setOpen(false),
									},
									"取消",
								),
								react.createElement(
									"button",
									{
										type: "button",
										className: CLS.btn + " " + CLS.btnPrimary,
										style: fallback ? fallback.btn : undefined,
										disabled: busy,
										onClick: submit,
									},
									busy ? "处理中…" : value.trim() ? "用这个名字" : "自动起名",
								),
							),
						)
					: null,
			);
		}

		function apply(ctx) {
			try {
				ensureStylesheet();
			} catch (e) {}
			try {
				if (!ctx || !ctx.slots || typeof ctx.slots.inject !== "function") return;
				ctx.slots.inject("conversation.session.header.actions", () =>
					ctx.slots.register(
						{
							name: "conversation.session.header.actions",
							id: "session-retitle",
							order: 15,
						},
						RetitleAction,
					),
				);
			} catch (err) {
				try {
					console.warn("[dsh-session-retitle] 客户端按钮注册失败（已忽略）：", err);
				} catch (e) {}
			}
		}

		module.exports = {
			name: "dsh-session-retitle",
			inject: ["slots"],
			apply,
			// 仅供自测使用（DSH 只读 name/inject/apply）
			__test: { SHEET, CLS, STYLE_ID, PALETTE, paletteFor, detectTheme, dswVariablesAvailable, fallbackStyles, ensureStylesheet },
		};
		return module.exports;
	},
});
