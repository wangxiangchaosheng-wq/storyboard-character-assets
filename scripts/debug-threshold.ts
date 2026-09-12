import { buildSpec, MockProvider } from "../packages/engine-core/src/index.ts";
import { openStore } from "../packages/serve/src/store.ts";
import { startSession, handleMessage } from "../packages/serve/src/gamesflow.ts";
import { MockSearchProvider } from "../packages/llm/src/index.ts";
import { randomBytes } from "node:crypto";

const llm = new MockProvider();
const search = new MockSearchProvider();
const customSpec = {
  domain: "custom" as const,
  title: "边界测试",
  scenario: { title: "边界测试", background: "测试", conflict: "测试", participants: ["p1"], rounds: 1, decisionPoint: "测试", successCriteria: "测试" },
  cast: [{ id: "p1", name: "测试官", role: "测试", stance: "保守", influence: 50, description: "", prompt: "你是测试官。", traits: { competence: 60, loyalty: 60, ambition: 40, power: 40 } }],
  metrics: [
    { key: "hp", label: "血量", min: 0, max: 100, start: 50, higherIsBetter: true, description: "生命值" },
  ],
  rules: [
    { id: "r-drift", kind: "drift", label: "自然消耗", description: "每回合-2", target: "hp", formula: "-2" },
    { id: "r-reac", kind: "reaction", label: "决策影响", description: "裁决对hp的影响", appliesTo: ["hp"], bounds: 50 },
    { id: "r-thr", kind: "threshold", label: "濒死", description: "hp<=0", metric: "hp", op: "<=", value: 10, fires: "血量见底" },
  ],
  rounds: 1,
};
const store = openStore();
const gameId = "g" + randomBytes(4).toString("hex");
const rt = await startSession(store, llm, customSpec, "test", gameId, "玩家", search);
console.log("初始 hp:", rt.state["hp"]);

const r1 = await handleMessage(store, llm, customSpec, "test", gameId, { text: "削弱", act: true }, search);
console.log("诏令1 hp:", r1.rt.state["hp"]);
console.log("诏令1 events:", r1.added.filter((m: any) => m.kind === "event").map((m: any) => m.text));

const r2 = await handleMessage(store, llm, customSpec, "test", gameId, { text: "继续削弱", act: true }, search);
console.log("诏令2 hp:", r2.rt.state["hp"]);
console.log("诏令2 events:", r2.added.filter((m: any) => m.kind === "event").map((m: any) => m.text));
