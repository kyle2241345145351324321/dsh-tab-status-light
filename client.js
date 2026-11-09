/**
 * Tab status light.
 *
 * The browser tab icon is the page logo the user watches while a turn runs, so
 * this bundle paints the AI session state onto it:
 *
 * - gray, blinking: the main session is running a turn. The dark half of the
 *   blink is the untouched shipped logo, so the tab pulses between "mark" and
 *   "mark + dot" instead of fading a dot in and out.
 * - yellow: the session is waiting for the user (question, approval, plan review);
 *   stays lit until the user answers.
 * - green: the last turn finished normally.
 * - red: the last turn was aborted, blocked, errored, or crash-interrupted.
 * - settled states fade back to the untouched logo after `SETTLE_MS` (green) or
 *   `SETTLE_MS_RED` (red) without new activity, so a finished tab stops advertising.
 * - opening a session that merely *had* finished earlier shows nothing: a settled
 *   badge is only painted for a turn this plugin actually watched run.
 *
 * State comes from the Client services that already own it: the main view's
 * identity from the Session list (`retainedBy.mainView`), running and pending
 * interaction from `uiSession.sessionStatus`, and the closing turn's reason from
 * the session event window's newest `turn/end`. A favicon has no slot, so the
 * shipped `link[rel~="icon"]` elements are the one thing this plugin edits
 * outside a component; their original `href` values are restored on teardown.
 */
window.__ModuleLoader__.load({
	id: "@local/tab-status-light",
	factory: () => {
		/** State -> badge color. Icon artwork is the one place literal colors are correct: an SVG favicon document cannot read page theme tokens. */
		const BADGE_COLOR = {
			working: "#9ca3af",
			asking: "#eab308",
			done: "#22c55e",
			interrupted: "#ef4444"
		};
		/** Turn endings that must read as "interrupted" rather than "done". */
		const RED_TURN_END_KINDS = new Set(["aborted", "blocked", "error", "interrupted"]);
		/** Badge geometry inside the shipped 50x50 favicon viewBox (bottom-right corner). */
		const BADGE = { cx: 37, cy: 37, radius: 11, ring: 4 };
		/** Ring color per browser theme: separates the badge from the monochrome mark on either tab background. */
		const RING = { dark: "#35363a", light: "#ffffff" };
		/** Blink period: the icon alternates between the shipped logo and the logo with the gray dot. */
		const BLINK_MS = 600;
		/** How long a green (turn finished) badge stays before the tab returns to the plain logo. */
		const SETTLE_MS = 10000;
		/** Same for red: an interruption is louder news, so it stays on the tab longer. */
		const SETTLE_MS_RED = 20000;
		const SVG_CLOSE = "</svg>";
		/**
		 * Blink driver source. Chrome throttles page timers in hidden tabs (down to one
		 * tick per minute under intensive throttling), which freezes the blink exactly
		 * when the user is looking at another tab — the case this light exists for. A
		 * dedicated Worker keeps its own timer outside that throttling.
		 */
		const TICKER_SOURCE = "let h=null;onmessage=(e)=>{const ms=e.data;if(h!==null){clearInterval(h);h=null}if(ms>0)h=setInterval(()=>postMessage(0),ms)};";

		/**
		 * Interval that keeps ticking while the tab is in the background.
		 * @param ms - tick period.
		 * @param onTick - called once per tick.
		 * @returns a disposer.
		 */
		function startTicker(ms, onTick) {
			try {
				const url = URL.createObjectURL(new Blob([TICKER_SOURCE], { type: "text/javascript" }));
				const worker = new Worker(url);
				URL.revokeObjectURL(url);
				worker.onmessage = () => onTick();
				worker.postMessage(ms);
				return () => {
					worker.onmessage = null;
					worker.postMessage(0);
					worker.terminate();
				};
			} catch {
				// No Worker/Blob in this environment: the page timer still works in the
				// foreground, the browser just throttles it once the tab is hidden.
				const timer = globalThis.setInterval(onTick, ms);
				return () => globalThis.clearInterval(timer);
			}
		}

		/**
		 * Wrap one SVG document in a base64 data URL. The favicon art is ASCII, so
		 * encoding is lossless.
		 * @param svg - complete SVG document text.
		 * @returns a `data:` URL the favicon link accepts.
		 */
		function toDataUrl(svg) {
			return "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(svg)));
		}

		/**
		 * Badge markup for one state.
		 * @param state - one of `BADGE_COLOR`'s keys.
		 * @param ring - ring color for the surrounding browser theme.
		 * @returns the SVG circle element.
		 */
		function badgeMarkup(state, ring) {
			return '<circle cx="' + BADGE.cx + '" cy="' + BADGE.cy + '" r="' + BADGE.radius +
				'" fill="' + BADGE_COLOR[state] +
				'" stroke="' + ring + '" stroke-width="' + BADGE.ring + '"/>';
		}

		/**
		 * Owns the tab icons: reads the shipped icon documents once, derives one
		 * data URL per theme/state, and restores the shipped icons when the plugin
		 * unloads.
		 */
		function createIconPainter() {
			let frames = null;
			let wantedState;
			let disposed = false;
			const cache = new Map();

			const reading = (async () => {
				const links = Array.from(document.head.querySelectorAll('link[rel~="icon"]'));
				const loaded = [];
				for (const link of links) {
					const media = link.getAttribute("media") ?? "";
					const frame = {
						link,
						original: link.getAttribute("href"),
						theme: /dark/i.test(media) ? "dark" : "light",
						art: null
					};
					try {
						const response = await fetch(link.href);
						if (response.ok) {
							const text = await response.text();
							const end = text.lastIndexOf(SVG_CLOSE);
							if (text.includes("<svg") && end > 0) frame.art = text.slice(0, end);
						}
					} catch {
						// A failed read keeps the plain-badge fallback.
					}
					loaded.push(frame);
				}
				return loaded;
			})().catch(() => []);

			/**
			 * Data URL for one frame's current state.
			 * @param frame - one shipped icon slot.
			 * @param state - badge state.
			 * @returns the icon URL.
			 */
			function hrefFor(frame, state) {
				const key = frame.theme + "|" + state + "|" + (frame.art === null ? "plain" : "brand");
				const cached = cache.get(key);
				if (cached !== undefined) return cached;
				const badge = badgeMarkup(state, RING[frame.theme]);
				const svg = frame.art === null
					? '<svg xmlns="http://www.w3.org/2000/svg" width="50" height="50" viewBox="0 0 50 50">' + badge + SVG_CLOSE
					: frame.art + badge + SVG_CLOSE;
				const href = toDataUrl(svg);
				cache.set(key, href);
				return href;
			}

			/** Write the wanted state onto every shipped icon link. */
			function paint() {
				if (disposed || frames === null) return;
				for (const frame of frames) {
					const href = wantedState === undefined ? frame.original : hrefFor(frame, wantedState);
					if (href === null || frame.link.getAttribute("href") === href) continue;
					frame.link.setAttribute("href", href);
				}
			}

			return {
				/** Begin reading the shipped icons and paint the wanted state afterwards. */
				start() {
					reading.then((loaded) => {
						if (disposed) return;
						frames = loaded;
						paint();
					});
				},
				/**
				 * Request one visual state.
				 * @param state - badge state, or undefined for the untouched shipped icon.
				 */
				set(state) {
					wantedState = state;
					paint();
				},
				/** Restore every shipped icon and drop derived URLs. */
				dispose() {
					disposed = true;
					if (frames !== null) {
						for (const frame of frames) {
							if (frame.original !== null) frame.link.setAttribute("href", frame.original);
						}
					}
					cache.clear();
				}
			};
		}

		/**
		 * Tracks the main session's state and drives the painter.
		 * @param ctx - the Client root context.
		 * @param painter - icon painter owned by the same effect.
		 */
		function createStatusLight(ctx, painter) {
			let mainId;
			let binding;
			let stopEvents;
			let turnEndKind;
			let appliedState;
			let appliedActivity = -1;
			/** Bumped whenever something actually happens (new turn end, session switch), so a faded badge can come back. */
			let activity = 0;
			let stopBlink;
			let stopSettle;
			/**
			 * Whether a turn has actually been seen running since this session was bound.
			 * A finished session that is merely opened must stay quiet: green/red are news
			 * about a turn the user watched, not a status replayed from history.
			 */
			let sawRunning = false;

			/** Drop both timers (blink and settle). */
			function stopTimers() {
				if (stopBlink !== undefined) {
					stopBlink();
					stopBlink = undefined;
				}
				if (stopSettle !== undefined) {
					stopSettle();
					stopSettle = undefined;
				}
			}

			/**
			 * Newest `turn/end` reason in the session event window.
			 * @param source - the Session's event source.
			 * @returns the reason kind, or undefined before any turn closed.
			 */
			function readTurnEndKind(source) {
				const entries = source.getSnapshot().entries;
				for (let index = entries.length - 1; index >= 0; index -= 1) {
					const entry = entries[index];
					if (entry.type === "event" && entry.event.type === "turn/end") return entry.event.data.reason.kind;
				}
				return undefined;
			}

			/**
			 * Session currently shown in the conversation view.
			 * @returns its identity, or undefined while no session is selected.
			 */
			function readMainId() {
				const list = ctx.sessions.list.getSnapshot();
				for (const id of list.ids) {
					const row = list.byId[id];
					if (row !== undefined && row.retainedBy !== undefined && row.retainedBy.mainView !== undefined) return id;
				}
				return undefined;
			}

			/** The one state the icon should show right now. */
			function readState() {
				if (mainId === undefined) return undefined;
				const status = ctx.uiSession.sessionStatus.getSnapshot().get(mainId);
				if (status !== undefined) {
					if (status.pendingInteraction !== undefined) return "asking";
					if (status.running === true) return "working";
				}
				// Only a turn this plugin watched run may leave a settled badge behind.
				if (turnEndKind === undefined || !sawRunning) return undefined;
				return RED_TURN_END_KINDS.has(turnEndKind) ? "interrupted" : "done";
			}

			/**
			 * Paint the current state. Re-paints only when the state or the activity
			 * token moved, so a settled badge that faded to the plain logo stays faded
			 * until something new happens.
			 */
			function apply() {
				const state = readState();
				if (state === appliedState && activity === appliedActivity) return;
				appliedState = state;
				appliedActivity = activity;
				stopTimers();
				if (state === undefined) {
					painter.set(undefined);
					return;
				}
				if (state === "working") {
					// Blink between the untouched logo and the logo carrying the dot:
					// the "off" half is the shipped mark, not a dimmed dot.
					let lit = true;
					painter.set(state);
					stopBlink = startTicker(BLINK_MS, () => {
						lit = !lit;
						painter.set(lit ? state : undefined);
					});
					return;
				}
				painter.set(state);
				if (state === "asking") return;
				// A settled badge is news, not a permanent decoration: let the tab go back
				// to the plain logo once nothing new has happened for a while. Interruptions
				// stay longer than completions.
				const timer = globalThis.setTimeout(() => {
					stopSettle = undefined;
					painter.set(undefined);
				}, state === "interrupted" ? SETTLE_MS_RED : SETTLE_MS);
				stopSettle = () => globalThis.clearTimeout(timer);
			}

			/**
			 * Observe the newest `turn/end` of the bound session.
			 * @param source - the binding's event source.
			 */
			function watchEvents(source) {
				stopEvents = source.subscribe((window) => {
					const change = window.change;
					if (change.kind === "append") {
						for (let index = change.entries.length - 1; index >= 0; index -= 1) {
							const entry = change.entries[index];
							if (entry.type === "event" && entry.event.type === "turn/end") {
								turnEndKind = entry.event.data.reason.kind;
								activity += 1;
								apply();
								return;
							}
						}
						return;
					}
					if (change.kind === "replace") {
						turnEndKind = readTurnEndKind(source);
						apply();
					}
				});
			}

			/** Re-bind to the main session when identity or generation changed, then paint. */
			function sync() {
				const nextId = readMainId();
				const nextBinding = nextId === undefined ? undefined : ctx.sessions.binding(nextId);
				/** A switch to another session is a switch; a new binding generation for the same session is not. */
				const switched = nextId !== mainId;
				if (switched || nextBinding !== binding) {
					mainId = nextId;
					binding = nextBinding;
					if (stopEvents !== undefined) {
						stopEvents();
						stopEvents = undefined;
					}
					if (switched) {
						activity += 1;
						turnEndKind = undefined;
						// Opening a session is not an event: its already-finished history must not
						// flash a green/red badge. Only a turn seen running here may settle.
						sawRunning = false;
					}
					if (nextBinding !== undefined) {
						// Subscribe before the scan below: a window that replaced its entries
						// before this moment would never deliver a change callback afterwards.
						watchEvents(nextBinding.eventSource);
					}
				}
				if (mainId !== undefined) {
					const status = ctx.uiSession.sessionStatus.getSnapshot().get(mainId);
					if (status !== undefined && status.running === true) sawRunning = true;
				}
				// Always rescan: a turn that closed while the stream was silent (or while no
				// subscription was in place yet) is only visible in the window itself.
				turnEndKind = nextBinding === undefined ? undefined : readTurnEndKind(nextBinding.eventSource);
				apply();
			}

			return {
				/** Install the subscriptions; call from the owning effect. */
				start() {
					const stopList = ctx.sessions.list.subscribe(sync);
					const stopStatus = ctx.uiSession.sessionStatus.subscribe(sync);
					sync();
					return () => {
						stopList();
						stopStatus();
						if (stopEvents !== undefined) stopEvents();
						stopTimers();
						stopEvents = undefined;
					};
				}
			};
		}

		return {
			inject: ["sessions", "uiSession"],
			/**
			 * Start the tab status light.
			 * @param ctx - the Client root context.
			 */
			apply(ctx) {
				const painter = createIconPainter();
				const light = createStatusLight(ctx, painter);
				ctx.effect(() => {
					painter.start();
					const stopLight = light.start();
					return () => {
						stopLight();
						painter.dispose();
					};
				}, "tab-status-light: main session state");
			}
		};
	}
});
