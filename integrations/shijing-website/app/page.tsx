import LauncherScreen from './components/LauncherScreen';

/**
 * 根页面 = 启动器。
 *
 * 史境的入口必须是「门面」而不是一张直接铺开的 iframe 地图：标题、择局、续局、调试
 * 四个入口摆在玩家面前，选好了才进场。Electron 桌面壳加载的就是这一页，
 * 因此所有模式（玩家局 / 调试）都从这一个独立页面出发。
 */
export default function Home() {
  return <LauncherScreen />;
}
