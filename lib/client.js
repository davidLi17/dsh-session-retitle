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

		const COLORS = {
			ok: "#16a34a",
			bad: "#dc2626",
		};

		const buttonStyle = {
			appearance: "none",
			background: "transparent",
			border: "1px solid var(--dsh-border-color, rgba(127,127,127,.38))",
			borderRadius: "6px",
			color: "inherit",
			cursor: "pointer",
			font: "inherit",
			fontSize: "12px",
			lineHeight: "1.4",
			padding: "2px 8px",
			opacity: 1,
		};

		const panelStyle = {
			position: "absolute",
			right: 0,
			top: "calc(100% + 6px)",
			zIndex: 40,
			width: "260px",
			padding: "10px",
			display: "flex",
			flexDirection: "column",
			gap: "8px",
			borderRadius: "10px",
			border: "1px solid var(--dsh-border-color, rgba(127,127,127,.32))",
			background: "var(--dsh-bg-elevated, var(--dsh-bg, #fff))",
			boxShadow: "0 10px 30px rgba(0,0,0,.18)",
			color: "inherit",
			textAlign: "left",
		};

		const inputStyle = {
			width: "100%",
			boxSizing: "border-box",
			padding: "5px 8px",
			borderRadius: "6px",
			border: "1px solid var(--dsh-border-color, rgba(127,127,127,.38))",
			background: "transparent",
			color: "inherit",
			font: "inherit",
			fontSize: "12px",
		};

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

			return react.createElement(
				"span",
				{ ref: rootRef, style: { position: "relative", display: "inline-flex", alignItems: "center", gap: "6px" } },
				react.createElement(
					"button",
					{
						type: "button",
						style: { ...buttonStyle, cursor: busy ? "progress" : "pointer" },
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
								style: {
									fontSize: "11px",
									whiteSpace: "nowrap",
									maxWidth: "320px",
									overflow: "hidden",
									textOverflow: "ellipsis",
									color: COLORS[tone] || "inherit",
								},
								title: note,
							},
							note,
						)
					: null,
				open
					? react.createElement(
							"div",
							{ style: panelStyle, role: "dialog", "aria-label": "重命名会话" },
							react.createElement(
								"div",
								{ style: { fontSize: "11px", opacity: 0.72 } },
								"留空 = 按会话内容自动起名",
							),
							react.createElement("input", {
								ref: inputRef,
								style: inputStyle,
								value,
								placeholder: "也可以直接输入新名字",
								disabled: busy,
								onChange: (event) => setValue(event.target.value),
								onKeyDown: onInputKeyDown,
							}),
							react.createElement(
								"div",
								{ style: { display: "flex", justifyContent: "flex-end", gap: "6px" } },
								react.createElement(
									"button",
									{
										type: "button",
										style: buttonStyle,
										disabled: busy,
										onClick: () => setOpen(false),
									},
									"取消",
								),
								react.createElement(
									"button",
									{
										type: "button",
										style: { ...buttonStyle, fontWeight: 600, cursor: busy ? "progress" : "pointer" },
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
		};
		return module.exports;
	},
});
