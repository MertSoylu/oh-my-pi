import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { type Api, Effort, type Model } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * Contract for `SessionManager.isDraftSubmittedContent` (issue #5741): a draft
 * persisted at shutdown is restored on resume only when it is genuinely unsent.
 * A draft that equals a submitted user message, or is assembled entirely from
 * verbatim fragments of submitted messages, is a leaked editor buffer and must
 * be reported as submitted so the restore is suppressed — while a novel prompt
 * (even one that repeats a fragment of an old message) must be kept.
 */
describe("SessionManager.isDraftSubmittedContent", () => {
	let tempDir: TempDir;
	let sessionManager: SessionManager;

	beforeEach(() => {
		tempDir = TempDir.createSync("@draft-restore-collision-");
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
	});

	afterEach(async () => {
		try {
			await tempDir.remove();
		} catch {}
	});

	function sendUserMessage(text: string): void {
		sessionManager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
	}

	it("never suppresses a draft in a session with no submitted user messages", () => {
		expect(sessionManager.isDraftSubmittedContent("anything at all")).toBe(false);
	});

	it("reports a draft that equals a submitted user message verbatim", () => {
		sendUserMessage("Run brainstorming acceptance test via headless omp");
		expect(sessionManager.isDraftSubmittedContent("Run brainstorming acceptance test via headless omp")).toBe(true);
	});

	it("reports a multi-line draft assembled from fragments of several submitted messages", () => {
		sendUserMessage("Run brainstorming acceptance test via headless omp");
		sendUserMessage("something is broken in my powerlevel 10k or 9k this is native zsh");
		sendUserMessage("PROMPT=[$PROMPT] && typeset -p POWERLEVEL9K_LEFT_PROMPT_ELEMENTS");

		const leaked = [
			"Run brainstorming acceptance test via headless omp",
			"PROMPT=[$PROMPT] && typeset -p POWERLEVEL9K_LEFT_PROMPT_ELEMENTS",
		].join("\n");
		expect(sessionManager.isDraftSubmittedContent(leaked)).toBe(true);
	});

	it("keeps a genuinely unsent draft that appears nowhere in the transcript", () => {
		sendUserMessage("Run brainstorming acceptance test via headless omp");
		expect(sessionManager.isDraftSubmittedContent("a brand new prompt nobody ever sent")).toBe(false);
	});

	it("keeps a single-line draft that merely repeats a fragment of a submitted message", () => {
		sendUserMessage("please git add -A and commit the changes");
		expect(sessionManager.isDraftSubmittedContent("git add -A")).toBe(false);
	});

	it("keeps a multi-line draft that mixes submitted fragments with new content", () => {
		sendUserMessage("Run brainstorming acceptance test via headless omp");
		const mixed = ["Run brainstorming acceptance test via headless omp", "but this follow-up is new"].join("\n");
		expect(sessionManager.isDraftSubmittedContent(mixed)).toBe(false);
	});
});

/**
 * End-to-end draft lifecycle through the real persisted sidecar (issue #5741):
 * the shutdown path writes the composer buffer to `draft.txt` and the next
 * launch reads it once; the restore decision must suppress a draft whose
 * content was already submitted while restoring a genuinely unsent one.
 */
describe("draft sidecar lifecycle (issue #5741)", () => {
	let tempDir: TempDir;
	let sessionManager: SessionManager;

	beforeEach(() => {
		tempDir = TempDir.createSync("@draft-restore-lifecycle-");
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
	});

	afterEach(async () => {
		try {
			await tempDir.remove();
		} catch {}
	});

	it("suppresses a leaked draft that equals submitted content across the real save/consume cycle", async () => {
		sessionManager.appendMessage({
			role: "user",
			content: "Run brainstorming acceptance test via headless omp",
			timestamp: Date.now(),
		});
		sessionManager.appendMessage({
			role: "user",
			content: "PROMPT=[$PROMPT] && typeset -p POWERLEVEL9K_LEFT_PROMPT_ELEMENTS",
			timestamp: Date.now(),
		});
		const leaked = [
			"Run brainstorming acceptance test via headless omp",
			"PROMPT=[$PROMPT] && typeset -p POWERLEVEL9K_LEFT_PROMPT_ELEMENTS",
		].join("\n");

		// Shutdown writes the composer buffer; the next launch reads it once.
		await sessionManager.saveDraft(leaked);
		const draft = await sessionManager.consumeDraft();
		expect(draft).toBe(leaked);
		// The restore predicate (interactive-mode) drops it as already-submitted.
		expect(sessionManager.isDraftSubmittedContent(draft ?? "")).toBe(true);
	});

	it("restores a genuinely unsent draft across the real save/consume cycle", async () => {
		sessionManager.appendMessage({
			role: "user",
			content: "Run brainstorming acceptance test via headless omp",
			timestamp: Date.now(),
		});
		const unsent = "a brand new prompt nobody ever sent";

		await sessionManager.saveDraft(unsent);
		const draft = await sessionManager.consumeDraft();
		expect(draft).toBe(unsent);
		expect(sessionManager.isDraftSubmittedContent(draft ?? "")).toBe(false);
	});
});

/**
 * Full restore path through `InteractiveMode.init` (issue #5741): the composer
 * must stay empty when the persisted draft collides with submitted content,
 * when the launch is not an explicit resume, and must receive a genuinely
 * unsent draft on an explicit resume.
 */
describe("InteractiveMode draft restore (issue #5741)", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let createdMode: InteractiveMode | undefined;
	let createdSession: AgentSession | undefined;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@draft-restore-e2e-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		Settings.instance.set("startup.quiet", true);
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		createdMode?.stop();
		await createdSession?.dispose();
		await authStorage?.close();
		tempDir?.removeSync();
		createdMode = undefined;
		createdSession = undefined;
		resetSettingsForTest();
	});

	function makeReadTool(): AgentTool {
		return {
			name: "read",
			label: "read",
			description: "Fake read tool",
			parameters: type({}),
			async execute() {
				return { content: [{ type: "text" as const, text: "ok" }] };
			},
		};
	}

	async function createMode(sessionDir: string): Promise<{ mode: InteractiveMode; manager: SessionManager }> {
		const registry = new ModelRegistry(authStorage, path.join(tempDir.path(), `models-${Bun.nanoseconds()}.yml`));
		const model = registry.find("anthropic", "claude-sonnet-4-5") as Model<Api> | undefined;
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		const readTool = makeReadTool();
		const toolRegistry = new Map<string, AgentTool>([[readTool.name, readTool]]);
		const manager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), sessionDir));
		const session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [readTool],
					messages: [],
					thinkingLevel: Effort.Medium,
				},
			}),
			sessionManager: manager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: registry,
			toolRegistry,
			builtInToolNames: ["read"],
		});
		createdSession = session;
		const mode = new InteractiveMode(session, "test");
		createdMode = mode;
		return { mode, manager };
	}

	it("keeps the composer empty when the resumed draft collides with submitted content", async () => {
		const { mode, manager } = await createMode("session-leak");
		manager.appendMessage({
			role: "user",
			content: "Run brainstorming acceptance test via headless omp",
			timestamp: Date.now(),
		});
		manager.appendMessage({
			role: "user",
			content: "PROMPT=[$PROMPT] && typeset -p POWERLEVEL9K_LEFT_PROMPT_ELEMENTS",
			timestamp: Date.now(),
		});
		const leaked = [
			"Run brainstorming acceptance test via headless omp",
			"PROMPT=[$PROMPT] && typeset -p POWERLEVEL9K_LEFT_PROMPT_ELEMENTS",
		].join("\n");
		await manager.saveDraft(leaked);

		await mode.init({ suppressWelcomeIntro: true, restoreEditorDraft: true });

		expect(mode.editor.getText()).toBe("");
	});

	it("restores a genuinely unsent draft on an explicit resume", async () => {
		const { mode, manager } = await createMode("session-unsent");
		manager.appendMessage({
			role: "user",
			content: "Run brainstorming acceptance test via headless omp",
			timestamp: Date.now(),
		});
		const unsent = "a brand new prompt nobody ever sent";
		await manager.saveDraft(unsent);

		await mode.init({ suppressWelcomeIntro: true, restoreEditorDraft: true });

		expect(mode.editor.getText()).toBe(unsent);
	});

	it("keeps the composer empty on a non-resume launch even with a genuine draft", async () => {
		const { mode, manager } = await createMode("session-fresh");
		manager.appendMessage({
			role: "user",
			content: "Run brainstorming acceptance test via headless omp",
			timestamp: Date.now(),
		});
		const unsent = "a brand new prompt nobody ever sent";
		await manager.saveDraft(unsent);

		await mode.init({ suppressWelcomeIntro: true, restoreEditorDraft: false });

		expect(mode.editor.getText()).toBe("");
	});
});
