/**
 * electron 主进程的 Steam 钩子入口。
 *
 * 为什么有这一层：桌面壳（electron/main.mts）的约定是「发现 steam/ 目录就动态 import 它的
 * 入口文件并调用 init(context)，找不到或失败就跳过，且任何异常都不能影响游戏启动」。本文件
 * 就是那个入口——只做适配（壳的 context → steam.ts 的 initSteam），探测、no-op、关闭逻辑
 * 全在 steam.ts 里，两边不重复。
 *
 * 注意：本文件直接 import TypeScript 源文件，需要 Node ≥ 22.18（类型剥离默认开启）。更低版本
 * 的运行时 import 会失败，桌面壳会按约定记一行日志后跳过 Steam 集成，不影响游戏。
 */
import {initSteam, isSteamAvailable, shutdownSteam} from './steam.ts';

/**
 * @param {{mode?:string;root?:string;versions?:Record<string,string>}} context 桌面壳传入的上下文
 * @returns {Promise<import('./steam.ts').SteamStatus>} Steam 初始化状态；不可用时 reason 说明原因
 */
export async function init(context = {}) {
  const status = initSteam();
  const where = context.root ? `（root=${context.root}）` : '';
  if (status.available) {
    console.log(`[steam] 已接入 Steam：appid=${status.appId}${status.user ? ` user=${status.user}` : ''}${where}`);
  } else {
    console.log(`[steam] 未接入 Steam，游戏以非 Steam 模式运行：${status.reason ?? '未知原因'}${where}`);
  }
  return status;
}

export {initSteam, isSteamAvailable, shutdownSteam};
export {ACHIEVEMENTS, evaluateAchievements, achievementSummary} from './achievements.ts';
export {createCloudSave, createSteamCloudSave, exportRunToSave, importRunFromSave} from './cloud-save.ts';
