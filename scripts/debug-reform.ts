import { buildSpec, MockProvider } from "../packages/engine-core/src/index.ts";
import { openStore } from "../packages/serve/src/store.ts";
import { startSession, reformGame } from "../packages/serve/src/gamesflow.ts";
import { MockSearchProvider } from "../packages/llm/src/index.ts";
import { randomBytes } from "node:crypto";

const llm = new MockProvider();
const search = new MockSearchProvider();
const spec = buildSpec("history", "架空：蜀国同时攻打魏国和吴国，诸葛亮会怎么选择？", 4);
const store = openStore();
const gameId = "g" + randomBytes(4).toString("hex");
const rt = await startSession(store, llm, spec, "test-spec-id", gameId, "主上", search);
console.log("初始 cast:", rt.spec.cast.map((p: any) => p.name).join(","));

const reform = await reformGame(store, llm, rt.spec, "test-spec-id", gameId, "十年后，蒋琬接任丞相，朝中风向转主守");
console.log("reform keys:", Object.keys(reform));
console.log("cast after:", reform.spec.cast.map((p: any) => p.name).join(","));
console.log("events:", reform.rt.chat.filter((m: any) => m.kind === "event").map((m: any) => m.text));
