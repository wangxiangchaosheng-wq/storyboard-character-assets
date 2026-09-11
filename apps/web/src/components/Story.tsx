/**
 * 中栏 —— 廷议对话流（docs/08 §2 StoryStream）：
 * 数据来自服务端 TurnView（回合标题 + 辩论发言 lines + 摘要）。
 */
import { useAsset } from '../assets/useAsset.ts';

export interface StoryLine {
  speaker: string; // cast id 或玩家名
  name: string;    // 显示名
  text: string;
  side: 'npc' | 'player';
  stance?: string;
}

function Bubble({ line }: { line: StoryLine }) {
  const skin = useAsset(line.side === 'npc' ? 'ui/bubble-npc' : 'ui/bubble-player');
  const avatar = useAsset(`portrait/${line.speaker}`);
  return (
    <div className={`story-line ${line.side}`}>
      <img className="bubble-avatar" src={avatar.url} alt={line.name} />
      <div
        className="bubble"
        style={skin.isPlaceholder ? undefined : { backgroundImage: `url(${skin.url})` }}
      >
        <div className="bubble-head">
          <b>{line.name}</b>
          {line.stance && <time>{line.stance}</time>}
        </div>
        <p>{line.text}</p>
      </div>
    </div>
  );
}

export function StoryPanel({
  title,
  subtitle,
  lines,
}: {
  title: string;
  subtitle?: string;
  lines: StoryLine[];
}) {
  const skin = useAsset('ui/panel-court');
  return (
    <section
      className="story-panel"
      style={skin.isPlaceholder ? undefined : { backgroundImage: `url(${skin.url})` }}
    >
      <h1 className="story-title">{title}</h1>
      {subtitle && <p className="story-subtitle">{subtitle}</p>}
      <div className="story-flow">
        {lines.map((l, i) => (
          <Bubble key={`${l.speaker}-${i}`} line={l} />
        ))}
      </div>
    </section>
  );
}