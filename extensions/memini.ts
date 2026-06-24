import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createHash } from "node:crypto";

import { StringEnum } from "@earendil-works/pi-ai";
import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DEFAULT_BASE_URL = "http://localhost:8080";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RECALL_LIMIT = 5;
const DEFAULT_NAMESPACE = "pi";
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const VALID_TIERS = ["working", "episodic", "semantic", "procedural"] as const;
const MEMORY_TOOL_NAMES = new Set([
	"memory_recall",
	"memory_remember",
	"memory_list",
	"memory_get",
	"memory_forget",
	"memory_answer",
	"memory_briefing",
]);
type Tier = (typeof VALID_TIERS)[number];

type JsonObject = Record<string, unknown>;

type FileConfig = Partial<{
	enabled: boolean;
	base_url: string;
	api_key: string;
	namespace: string;
	shared_namespaces: string[] | string;
	recall: boolean;
	capture: boolean;
	expose_tools: boolean;
	recall_limit: number;
	recall_max_tokens: number;
	recall_min_score: number;
	timeout_ms: number;
	fallback_on_error: boolean;
}>;

export interface ResolvedConfig {
	enabled: boolean;
	base_url: string;
	api_key: string;
	namespace: string;
	shared_namespaces: string[];
	recall: boolean;
	capture: boolean;
	expose_tools: boolean;
	recall_limit: number;
	recall_max_tokens: number;
	recall_min_score: number;
	timeout_ms: number;
	fallback_on_error: boolean;
}

interface ExtensionState {
	config: ResolvedConfig;
	client: MeminiClient;
	recallBlock?: string;
	capturedTurnHashes: Set<string>;
}

function envBool(value: unknown, fallback: boolean): boolean {
	if (value === undefined || value === null || value === "") return fallback;
	return !/^(0|false|no|off)$/i.test(String(value).trim());
}

function numberValue(value: unknown, fallback: number, min = 0): number {
	const n = Number(value);
	return Number.isFinite(n) && n >= min ? n : fallback;
}

function sanitizeNamespaceSegment(value: unknown): string {
	return String(value ?? "")
		.trim()
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function sanitizeNamespace(value: unknown): string {
	return String(value ?? "")
		.split("/")
		.map(sanitizeNamespaceSegment)
		.filter(Boolean)
		.join("/");
}

function namespaceList(value: unknown, exclude: string[] = []): string[] {
	const raw = Array.isArray(value) ? value : String(value ?? "").split(/[|,\s]+/);
	const excluded = new Set(exclude.map(sanitizeNamespace).filter(Boolean));
	const out: string[] = [];
	for (const item of raw) {
		const ns = sanitizeNamespace(item);
		if (!ns || excluded.has(ns) || out.includes(ns)) continue;
		out.push(ns);
	}
	return out;
}

export function deriveNamespace(worktreeOrCwd: string | undefined): string {
	if (!worktreeOrCwd?.trim()) return "";
	return sanitizeNamespace(basename(worktreeOrCwd.replace(/[\\/]+$/, "")));
}

export function resolveConfig(env: NodeJS.ProcessEnv, options: FileConfig = {}, worktreeOrCwd?: string): ResolvedConfig {
	const namespace = sanitizeNamespace(options.namespace || env.MEMINI_NAMESPACE || deriveNamespace(worktreeOrCwd) || DEFAULT_NAMESPACE) || DEFAULT_NAMESPACE;
	const sharedNamespaces = namespaceList(options.shared_namespaces ?? env.MEMINI_SHARED_NAMESPACES, [namespace]);
	return {
		enabled: options.enabled !== undefined ? options.enabled !== false : envBool(env.MEMINI_ENABLED, true),
		base_url: options.base_url || env.MEMINI_BASE_URL || env.MEMINI_URL || DEFAULT_BASE_URL,
		api_key: options.api_key || env.MEMINI_API_KEY || env.MEMINI_TOKEN || "",
		namespace,
		shared_namespaces: sharedNamespaces,
		recall: options.recall !== undefined ? options.recall !== false : envBool(env.MEMINI_RECALL, true),
		capture: options.capture !== undefined ? options.capture !== false : envBool(env.MEMINI_CAPTURE, true),
		expose_tools:
			options.expose_tools !== undefined ? options.expose_tools !== false : envBool(env.MEMINI_EXPOSE_TOOLS, true),
		recall_limit: numberValue(options.recall_limit ?? env.MEMINI_RECALL_LIMIT, DEFAULT_RECALL_LIMIT),
		recall_max_tokens: numberValue(options.recall_max_tokens ?? env.MEMINI_INJECT_RECALL_MAX_TOK, 0),
		recall_min_score: numberValue(options.recall_min_score ?? env.MEMINI_INJECT_RECALL_MIN_SCORE, 0),
		timeout_ms: numberValue(options.timeout_ms ?? env.MEMINI_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 1),
		fallback_on_error:
			options.fallback_on_error !== undefined
				? options.fallback_on_error !== false
				: envBool(env.MEMINI_FALLBACK, true),
	};
}

async function readJsonIfExists(path: string): Promise<FileConfig> {
	try {
		const raw = await readFile(path, "utf8");
		const parsed = JSON.parse(raw) as unknown;
		return parsed && typeof parsed === "object" ? (parsed as FileConfig) : {};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
}

async function resolveGitRoot(pi: ExtensionAPI, cwd: string): Promise<string> {
	try {
		const result = await pi.exec("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { timeout: 2_000 });
		if (result.code === 0 && result.stdout.trim()) return result.stdout.trim();
	} catch {
		// Fall through to cwd basename.
	}
	return cwd;
}

async function resolveRuntimeConfig(pi: ExtensionAPI, ctx: ExtensionContext): Promise<ResolvedConfig> {
	const globalConfigPath = join(homedir(), ".pi", "agent", "memini.json");
	const projectConfigPath = join(ctx.cwd, CONFIG_DIR_NAME, "memini.json");
	const globalConfig = await readJsonIfExists(globalConfigPath);
	const projectConfig = ctx.isProjectTrusted() ? await readJsonIfExists(projectConfigPath) : {};
	const worktree = await resolveGitRoot(pi, ctx.cwd);
	return resolveConfig(process.env, { ...globalConfig, ...projectConfig }, worktree);
}

function normalizedHostname(hostname: string): string {
	return hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

function usesPlaintextBearerAuth(baseUrl: string, secret: string | undefined): boolean {
	if (!secret) return false;
	try {
		const parsed = new URL(baseUrl);
		return parsed.protocol === "http:" && !LOOPBACK_HOSTS.has(normalizedHostname(parsed.hostname));
	} catch {
		return false;
	}
}

function plaintextBearerAuthMessage(baseUrl: string): string {
	return `memini: MEMINI_API_KEY is configured for plaintext HTTP to ${baseUrl}. Use HTTPS or an SSH tunnel, or unset MEMINI_REQUIRE_HTTPS.`;
}

class MeminiClient {
	private warnedPlaintext = false;
	private readonly secret: string;
	readonly baseUrl: string;

	constructor(private readonly cfg: ResolvedConfig) {
		this.baseUrl = String(cfg.base_url || DEFAULT_BASE_URL).replace(/\/+$/, "");
		this.secret = cfg.api_key || "";
	}

	private guardPlaintext(): void {
		if (!usesPlaintextBearerAuth(this.baseUrl, this.secret)) return;
		const message = plaintextBearerAuthMessage(this.baseUrl);
		if (process.env.MEMINI_REQUIRE_HTTPS === "1") throw new Error(message);
		if (!this.warnedPlaintext) {
			this.warnedPlaintext = true;
			console.warn(`[memini] ${message}`);
		}
	}

	async requestJson(
		method: "GET" | "POST" | "DELETE",
		path: string,
		payload: unknown,
		namespace: string | undefined,
		signal: AbortSignal | undefined,
		fallbackOnError: boolean,
	): Promise<unknown | null> {
		this.guardPlaintext();
		const headers: Record<string, string> = { "X-Memini-Namespace": namespace || this.cfg.namespace };
		if (payload !== undefined) headers["Content-Type"] = "application/json";
		if (this.secret) headers.Authorization = `Bearer ${this.secret}`;

		const timeoutSignal = AbortSignal.timeout(this.cfg.timeout_ms);
		const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
		try {
			const res = await fetch(`${this.baseUrl}${path}`, {
				method,
				headers,
				body: payload === undefined ? undefined : JSON.stringify(payload),
				signal: requestSignal,
			});
			if (!res.ok) {
				const body = await res.text().catch(() => "");
				throw new Error(`memini ${method} ${path} failed: ${res.status} ${body}`.trim());
			}
			if (res.status === 204) return { ok: true };
			const text = await res.text();
			return text ? (JSON.parse(text) as unknown) : { ok: true };
		} catch (error) {
			if (!fallbackOnError) throw error;
			console.warn(`[memini] ${String(error)}`);
			return null;
		}
	}

	get(path: string, namespace?: string, signal?: AbortSignal, fallbackOnError = this.cfg.fallback_on_error) {
		return this.requestJson("GET", path, undefined, namespace, signal, fallbackOnError);
	}

	post(path: string, payload: unknown, namespace?: string, signal?: AbortSignal, fallbackOnError = this.cfg.fallback_on_error) {
		return this.requestJson("POST", path, payload, namespace, signal, fallbackOnError);
	}

	delete(path: string, namespace?: string, signal?: AbortSignal, fallbackOnError = this.cfg.fallback_on_error) {
		return this.requestJson("DELETE", path, undefined, namespace, signal, fallbackOnError);
	}
}

function asText(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part) => {
			if (part && typeof part === "object" && (part as { type?: unknown }).type === "text") {
				return [String((part as { text?: unknown }).text ?? "")];
			}
			return [];
		})
		.join("\n")
		.trim();
}

function textFromMessage(message: any): string {
	if (!message || typeof message !== "object") return "";
	return asText(message.content);
}

function lastTextByRole(messages: any[], role: string): string {
	for (const entry of [...messages].reverse()) {
		const message = entry?.message ?? entry;
		if (message?.role === role) {
			const text = textFromMessage(message);
			if (text) return text;
		}
	}
	return "";
}

function truncate(value: string, max: number): string {
	return value.length > max ? `${value.slice(0, max)}\n[...truncated]` : value;
}

export function approxTokens(text: string): number {
	if (!text) return 0;
	const words = text.trim().split(/\s+/).filter(Boolean).length;
	return Math.max(1, Math.ceil((words * 4) / 3));
}

export function fitByTokens(items: string[], maxTokens: number): { items: string[]; dropped: number } {
	if (!Array.isArray(items) || items.length === 0) return { items: [], dropped: 0 };
	if (!Number.isFinite(maxTokens) || maxTokens <= 0) return { items: items.slice(), dropped: 0 };
	const out: string[] = [];
	let used = 0;
	let dropped = 0;
	for (const item of items) {
		const tokens = approxTokens(item);
		if (used + tokens > maxTokens) {
			dropped++;
			continue;
		}
		out.push(item);
		used += tokens;
	}
	return { items: out, dropped };
}

function labelsFromEnv(): Set<string> {
	const raw = process.env.MEMINI_INJECT_LABELS;
	if (!raw) return new Set();
	return new Set(raw.split(/[|,]/).map((s) => s.trim().toLowerCase()).filter(Boolean));
}

function formatAge(createdAt: unknown): string {
	if (!createdAt) return "";
	const t = new Date(String(createdAt)).getTime();
	if (!Number.isFinite(t)) return "";
	const days = Math.floor((Date.now() - t) / 86_400_000);
	if (days < 0) return "";
	return days === 0 ? "today" : `${days}d`;
}

export function formatSearchResults(results: unknown, limit: number, labels = labelsFromEnv()): string[] {
	if (!Array.isArray(results) || results.length === 0) return [];
	return results
		.slice(0, limit || DEFAULT_RECALL_LIMIT)
		.map((result, index) => {
			const r = result as { score?: unknown; memory?: Record<string, unknown> };
			const mem = r?.memory ?? {};
			const text = truncate(String(mem.summary || mem.content || `Memory ${index + 1}`).trim(), 300);
			if (!text) return null;
			const tier = String(mem.tier || "memory").trim();
			if (!labels.size) return `- (${tier}) ${text}`;
			const tagParts: string[] = [];
			if (labels.has("tier") && tier) tagParts.push(tier);
			if (labels.has("confidence") && typeof mem.confidence === "number") tagParts.push(`conf=${mem.confidence.toFixed(2)}`);
			if (labels.has("age")) {
				const age = formatAge(mem.created_at || mem.createdAt);
				if (age) tagParts.push(age);
			}
			return tagParts.length ? `- [${tagParts.join(" · ")}] ${text}` : `- (${tier}) ${text}`;
		})
		.filter((line): line is string => Boolean(line));
}

function mergeSearchResults(responses: unknown[], limit: number): unknown[] {
	const seen = new Set<string>();
	const out: Array<{ score?: unknown; memory?: Record<string, unknown> }> = [];
	for (const response of responses) {
		const results = (response as { results?: unknown } | null | undefined)?.results;
		if (!Array.isArray(results)) continue;
		for (const result of results) {
			const r = result as { score?: unknown; memory?: Record<string, unknown> };
			const mem = r?.memory ?? {};
			const key = `${String(mem.namespace ?? "")}\0${String(mem.id ?? mem.content ?? JSON.stringify(mem))}`;
			if (seen.has(key)) continue;
			seen.add(key);
			out.push(r);
		}
	}
	out.sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0));
	return out.slice(0, limit || DEFAULT_RECALL_LIMIT);
}

function buildRecallBlock(results: unknown, cfg: ResolvedConfig): string | undefined {
	const hits = formatSearchResults(results, cfg.recall_limit);
	if (hits.length === 0) return undefined;
	const fit = fitByTokens(hits, cfg.recall_max_tokens);
	if (fit.items.length === 0) return undefined;
	const lines = [
		"Relevant long-term memory from memini (background context — prefer current workspace state and the user's latest instructions):",
		...fit.items,
	];
	if (fit.dropped > 0) lines.push(`[... ${fit.dropped} item(s) truncated by token budget]`);
	return lines.join("\n");
}

function injectRecallIntoMessages(messages: any[], recallBlock: string): any[] {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role !== "user") continue;
		if (typeof message.content === "string") {
			if (!message.content.startsWith("Relevant long-term memory from memini")) {
				message.content = `${recallBlock}\n\n---\n\n${message.content}`;
			}
		} else if (Array.isArray(message.content)) {
			const firstText = message.content.find((part: any) => part?.type === "text")?.text ?? "";
			if (!String(firstText).startsWith("Relevant long-term memory from memini")) {
				message.content.unshift({ type: "text", text: recallBlock });
			}
		}
		break;
	}
	return messages;
}

function sessionIdentity(ctx: ExtensionContext): string {
	return sanitizeNamespace(ctx.sessionManager.getSessionId?.() || ctx.sessionManager.getSessionFile?.() || ctx.cwd);
}

function turnHash(userText: string, assistantText: string): string {
	return createHash("sha256").update(userText).update("\0").update(assistantText).digest("hex");
}

function validTier(value: unknown, fallback: Tier): Tier {
	return (VALID_TIERS as readonly string[]).includes(String(value)) ? (String(value) as Tier) : fallback;
}

function namespacePathParam(namespace: string): string {
	// Some HTTP gateways decode %2F before forwarding, which turns a namespace like
	// "main/projects/foo" into extra path segments. Double-encoding preserves the
	// slash through the gateway so memini receives it as one path parameter.
	return encodeURIComponent(encodeURIComponent(namespace));
}

function queryString(params: Record<string, unknown>): string {
	const q = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) {
		if (value === undefined || value === null || value === "") continue;
		if (Array.isArray(value)) {
			for (const item of value) q.append(key, String(item));
		} else if (typeof value === "object") {
			for (const [k, v] of Object.entries(value as Record<string, unknown>)) q.append(key, `${k}=${v}`);
		} else {
			q.set(key, String(value));
		}
	}
	const s = q.toString();
	return s ? `?${s}` : "";
}

function memorySummary(mem: any): string {
	const id = mem?.id ? ` ${mem.id}` : "";
	const tier = mem?.tier ? `(${mem.tier})` : "";
	const text = truncate(String(mem?.summary || mem?.content || "").trim(), 500);
	return `${id} ${tier} ${text}`.trim();
}

function formatToolJson(value: unknown, max = 40_000): string {
	const text = JSON.stringify(value, null, 2);
	return text.length > max ? `${text.slice(0, max)}\n... [truncated]` : text;
}

function textResult(text: string, details?: unknown) {
	return { content: [{ type: "text" as const, text }], details };
}

const NamespaceParam = Type.Optional(Type.String({ description: "Override the memini namespace. Omit to use the project namespace." }));
const TagsParam = Type.Optional(Type.Array(Type.String(), { description: "Tags to attach or filter by." }));
const MetadataParam = Type.Optional(
	Type.Record(Type.String(), Type.String(), {
		description: 'Top-level metadata key/value filters, e.g. {"category":"bug_fixes"}.',
	}),
);
const TierEnum = StringEnum([...VALID_TIERS] as unknown as string[]);

function registerMemoryTools(pi: ExtensionAPI, getState: () => ExtensionState) {
	pi.registerTool({
		name: "memory_recall",
		label: "Memory Recall",
		description: "Search long-term memory in memini over REST. Use this for relevant past facts, decisions, fixes, and preferences.",
		promptSnippet: "Search long-term memory in memini",
		promptGuidelines: [
			"Use memory_recall when the user asks about prior work, remembered preferences, earlier decisions, or historical project context.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "What to search for." }),
			limit: Type.Optional(Type.Number({ description: "Maximum results (default 5)." })),
			tags: TagsParam,
			metadata: MetadataParam,
			tiers: Type.Optional(Type.Array(TierEnum, { description: "Restrict search to memory tiers." })),
			min_score: Type.Optional(Type.Number({ description: "Optional fused-score floor." })),
			scope: Type.Optional(StringEnum(["exact", "subtree"])),
			namespace: NamespaceParam,
		}),
		async execute(_id, params, signal) {
			const state = getState();
			const body: JsonObject = { query: params.query, limit: params.limit || state.config.recall_limit };
			if (params.tags?.length) body.tags = params.tags;
			if (params.metadata && Object.keys(params.metadata).length) body.metadata = params.metadata;
			if (params.tiers?.length) body.tiers = params.tiers;
			if (params.min_score !== undefined) body.min_score = params.min_score;
			if (params.scope) body.scope = params.scope;
			const res = (await state.client.post("/v1/search", body, params.namespace, signal, false)) as any;
			const lines = formatSearchResults(res?.results, Number(body.limit));
			return textResult(lines.length ? lines.join("\n") : "No matching memories found.", res);
		},
	});

	pi.registerTool({
		name: "memory_remember",
		label: "Memory Remember",
		description: "Store a durable fact, decision, preference, or procedure in memini long-term memory over REST.",
		promptSnippet: "Store a fact, decision, preference, or procedure in memini",
		promptGuidelines: [
			"Use memory_remember when the user explicitly asks to remember something or when a durable project decision, preference, or procedure should be preserved.",
		],
		parameters: Type.Object({
			content: Type.String({ description: "The memory content to store." }),
			tier: Type.Optional(TierEnum),
			summary: Type.Optional(Type.String({ description: "Optional short summary." })),
			tags: TagsParam,
			category: Type.Optional(Type.String({ description: "Optional topic bucket stored as metadata.category." })),
			metadata: MetadataParam,
			importance: Type.Optional(Type.Number({ description: "Optional importance score." })),
			namespace: NamespaceParam,
		}),
		async execute(_id, params, signal) {
			const state = getState();
			const metadata: Record<string, string> = { ...(params.metadata ?? {}) };
			if (params.category) metadata.category = params.category;
			const body: JsonObject = { content: params.content, tier: validTier(params.tier, "semantic") };
			if (params.summary) body.summary = params.summary;
			if (params.tags?.length) body.tags = params.tags;
			if (Object.keys(metadata).length) body.metadata = metadata;
			if (params.importance !== undefined) body.importance = params.importance;
			const res = (await state.client.post("/v1/memories", body, params.namespace, signal, false)) as any;
			return textResult(`Stored memory ${res?.id ?? "(unknown id)"} in namespace ${params.namespace || state.config.namespace}.`, res);
		},
	});

	pi.registerTool({
		name: "memory_list",
		label: "Memory List",
		description: "Browse memini memories without a query. Filter by tier, tags, metadata, and limit.",
		parameters: Type.Object({
			tiers: Type.Optional(Type.Array(TierEnum)),
			tags: TagsParam,
			metadata: MetadataParam,
			limit: Type.Optional(Type.Number({ description: "Max results. Default 20. 0 means all." })),
			include_expired: Type.Optional(Type.Boolean()),
			include_superseded: Type.Optional(Type.Boolean()),
			namespace: NamespaceParam,
		}),
		async execute(_id, params, signal) {
			const state = getState();
			const path = `/v1/memories${queryString({
				tier: params.tiers,
				tag: params.tags,
				meta: params.metadata,
				limit: params.limit ?? 20,
				include_expired: params.include_expired,
				include_superseded: params.include_superseded,
			})}`;
			const res = (await state.client.get(path, params.namespace, signal, false)) as any;
			const memories = Array.isArray(res?.memories) ? res.memories : [];
			return textResult(memories.length ? memories.map(memorySummary).join("\n") : "No memories found.", res);
		},
	});

	pi.registerTool({
		name: "memory_get",
		label: "Memory Get",
		description: "Fetch one memini memory by id over REST.",
		parameters: Type.Object({ id: Type.String(), namespace: NamespaceParam }),
		async execute(_id, params, signal) {
			const state = getState();
			const res = await state.client.get(`/v1/memories/${encodeURIComponent(params.id)}`, params.namespace, signal, false);
			return textResult(formatToolJson(res), res);
		},
	});

	pi.registerTool({
		name: "memory_forget",
		label: "Memory Forget",
		description: "Delete a memini memory by id, or delete all memories carrying an exact tag.",
		parameters: Type.Object({
			id: Type.Optional(Type.String({ description: "Memory id to delete." })),
			tag: Type.Optional(Type.String({ description: "Exact tag; deletes every memory carrying it." })),
			namespace: NamespaceParam,
		}),
		async execute(_id, params, signal) {
			if ((params.id ? 1 : 0) + (params.tag ? 1 : 0) !== 1) throw new Error("Provide exactly one of id or tag.");
			const state = getState();
			const path = params.id
				? `/v1/memories/${encodeURIComponent(params.id)}`
				: `/v1/memories${queryString({ tag: params.tag })}`;
			const res = await state.client.delete(path, params.namespace, signal, false);
			return textResult(`Deleted memory${params.id ? ` ${params.id}` : ` tagged ${params.tag}`}.`, res);
		},
	});

	pi.registerTool({
		name: "memory_answer",
		label: "Memory Answer",
		description: "Ask memini to answer a question grounded in recalled memories.",
		parameters: Type.Object({
			query: Type.String(),
			limit: Type.Optional(Type.Number()),
			tags: TagsParam,
			metadata: MetadataParam,
			tiers: Type.Optional(Type.Array(TierEnum)),
			namespace: NamespaceParam,
		}),
		async execute(_id, params, signal) {
			const state = getState();
			const body: JsonObject = { query: params.query };
			if (params.limit !== undefined) body.limit = params.limit;
			if (params.tags?.length) body.tags = params.tags;
			if (params.metadata && Object.keys(params.metadata).length) body.metadata = params.metadata;
			if (params.tiers?.length) body.tiers = params.tiers;
			const res = (await state.client.post("/v1/answer", body, params.namespace, signal, false)) as any;
			return textResult(res?.answer || formatToolJson(res), res);
		},
	});

	pi.registerTool({
		name: "memory_briefing",
		label: "Memory Briefing",
		description: "Fetch memini's layered briefing for the current namespace: pinned, facts, procedures, and recent episodic memories.",
		parameters: Type.Object({
			per_section: Type.Optional(Type.Number({ description: "Default cap per section (default 5)." })),
			namespace: NamespaceParam,
		}),
		async execute(_id, params, signal) {
			const state = getState();
			const namespace = params.namespace || state.config.namespace;
			const res = await state.client.get(
				`/v1/namespaces/${namespacePathParam(namespace)}/briefing${queryString({ per_section: params.per_section })}`,
				namespace,
				signal,
				false,
			);
			return textResult(renderBriefing(res), res);
		},
	});
}

function renderBriefing(data: unknown): string {
	const briefing = (data ?? {}) as Record<string, any>;
	const sections: Array<[string, any[]]> = [
		["Pinned", briefing.pinned || []],
		["Facts", briefing.facts || []],
		["Procedures", briefing.procedures || []],
		["Recent", briefing.recent || []],
	];
	const lines = [`memini briefing for namespace ${briefing.namespace || "(unknown)"}`];
	for (const [title, memories] of sections) {
		if (!Array.isArray(memories) || memories.length === 0) continue;
		lines.push(`\n${title}:`);
		for (const mem of memories) lines.push(`- ${memorySummary(mem)}`);
	}
	return lines.length === 1 ? `${lines[0]}\nNo memories found.` : lines.join("\n");
}

export default function meminiExtension(pi: ExtensionAPI) {
	let state: ExtensionState = {
		config: resolveConfig(process.env, {}, process.cwd()),
		client: new MeminiClient(resolveConfig(process.env, {}, process.cwd())),
		capturedTurnHashes: new Set(),
	};

	const refreshState = async (ctx: ExtensionContext) => {
		const config = await resolveRuntimeConfig(pi, ctx);
		state = { config, client: new MeminiClient(config), capturedTurnHashes: state.capturedTurnHashes };
		if (!config.enabled || !config.expose_tools) {
			pi.setActiveTools(pi.getActiveTools().filter((name) => !MEMORY_TOOL_NAMES.has(name)));
		}
		if (ctx.hasUI) ctx.ui.setStatus("memini", config.enabled ? `memini:${config.namespace}` : undefined);
	};

	pi.on("session_start", async (_event, ctx) => {
		await refreshState(ctx);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		state.recallBlock = undefined;
		if (!state.config.enabled || !state.config.recall) return;
		const query = String(event.prompt || "").trim();
		if (!query) return;
		const body: JsonObject = { query, limit: state.config.recall_limit };
		const sid = sessionIdentity(ctx);
		if (sid) body.exclude_metadata = { session_id: sid };
		if (state.config.recall_min_score > 0) body.min_score = state.config.recall_min_score;
		const namespaces = namespaceList([state.config.namespace, ...state.config.shared_namespaces]);
		const responses = await Promise.all(
			namespaces.map((namespace) => state.client.post("/v1/search", body, namespace, ctx.signal, state.config.fallback_on_error)),
		);
		state.recallBlock = buildRecallBlock(mergeSearchResults(responses, state.config.recall_limit), state.config);
	});

	pi.on("context", async (event) => {
		if (!state.config.enabled || !state.recallBlock) return;
		return { messages: injectRecallIntoMessages(event.messages as any[], state.recallBlock) };
	});

	pi.on("agent_end", async (event, ctx) => {
		try {
			if (!state.config.enabled || !state.config.capture) return;
			const messages = (event.messages || []) as any[];
			const userText = lastTextByRole(messages, "user");
			const assistantText = lastTextByRole(messages, "assistant");
			if (!userText || !assistantText) return;
			const hash = turnHash(userText, assistantText);
			if (state.capturedTurnHashes.has(hash)) return;
			const sid = sessionIdentity(ctx);
			const body = {
				content: `${truncate(userText, 1_000)}\n\n${truncate(assistantText, 3_000)}`,
				tier: "episodic",
				tags: ["pi"],
				metadata: { source: "pi", session_id: sid, format: "turn" },
			};
			const stored = await state.client.post("/v1/memories", body, state.config.namespace, undefined, state.config.fallback_on_error);
			if (stored !== null) state.capturedTurnHashes.add(hash);
		} finally {
			state.recallBlock = undefined;
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setStatus("memini", undefined);
	});

	registerMemoryTools(pi, () => state);

	pi.registerCommand("memini-status", {
		description: "Show memini connection and namespace status",
		handler: async (_args, ctx) => {
			await refreshState(ctx);
			const health = await fetch(`${state.client.baseUrl}/healthz`, { signal: AbortSignal.timeout(state.config.timeout_ms) })
				.then((r) => `${r.status} ${r.statusText}`)
				.catch((error) => String(error));
			ctx.ui.notify(
				`memini ${state.config.enabled ? "enabled" : "disabled"}: ${state.client.baseUrl}, namespace=${state.config.namespace}, shared=${state.config.shared_namespaces.join(",") || "none"}, health=${health}`,
				"info",
			);
		},
	});

	pi.registerCommand("memini-briefing", {
		description: "Show a memini briefing for the current namespace",
		handler: async (_args, ctx) => {
			await refreshState(ctx);
			const res = await state.client.get(
				`/v1/namespaces/${namespacePathParam(state.config.namespace)}/briefing`,
				state.config.namespace,
				undefined,
				false,
			);
			pi.sendMessage({ customType: "memini", content: renderBriefing(res), display: true, details: res }, { triggerTurn: false });
		},
	});

	pi.registerCommand("memini-recall", {
		description: "Recall memini memories for a query: /memini-recall <query>",
		handler: async (args, ctx) => {
			await refreshState(ctx);
			const query = args.trim() || (await ctx.ui.input("memini recall", "query"));
			if (!query) return;
			const body: JsonObject = { query, limit: state.config.recall_limit };
			const namespaces = namespaceList([state.config.namespace, ...state.config.shared_namespaces]);
			const responses = await Promise.all(namespaces.map((namespace) => state.client.post("/v1/search", body, namespace, undefined, false)));
			const results = mergeSearchResults(responses, state.config.recall_limit);
			const lines = formatSearchResults(results, state.config.recall_limit);
			pi.sendMessage({ customType: "memini", content: lines.join("\n") || "No matching memories found.", display: true, details: { results } });
		},
	});

	pi.registerCommand("memini-remember", {
		description: "Store a semantic memini memory: /memini-remember <fact>",
		handler: async (args, ctx) => {
			await refreshState(ctx);
			const content = args.trim() || (await ctx.ui.editor("Remember in memini", ""));
			if (!content) return;
			const res = (await state.client.post(
				"/v1/memories",
				{ content, tier: "semantic", tags: ["pi", "manual"], metadata: { source: "pi", format: "manual" } },
				state.config.namespace,
				undefined,
				false,
			)) as any;
			ctx.ui.notify(`Stored memini memory ${res?.id ?? "(unknown id)"}`, "info");
		},
	});
}
