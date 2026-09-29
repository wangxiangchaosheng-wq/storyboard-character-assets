import PlayScreen from '../components/PlayScreen';

/**
 * 地图主页（/play?run=<id>）。
 *
 * 史境的核心界面：地图常满屏，顶栏时间与国力，侧轨点开各域面板，底部随时能下令。
 * 启动器的「开始新局 / 继续对局」都进这里；人物对话界面（/discussion）作为
 * 「廷议」面板继续可达。
 */
export default function PlayPage() {
  return <PlayScreen />;
}
