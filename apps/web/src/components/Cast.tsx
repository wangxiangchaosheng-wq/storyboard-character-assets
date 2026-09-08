/**
 * 左栏 · 角色列表（docs/12）：成员来自服务端 spec.cast；
 * 活跃度 = 是否在本回合发言。立绘用 useAsset（manifest 未登记 → 占位 SVG）。
 */
import { useAsset } from '../assets/useAsset.ts';

export interface CastMember {
  id: string;
  name: string;
  role: string;
  stance?: string;
  influence?: number;
  active: boolean;
}

function RoleCard({ cast }: { cast: CastMember }) {
  const { url, isPlaceholder } = useAsset(`portrait/${cast.id}`);
  return (
    <div className={`role-card ${cast.active ? 'active' : ''}`}>
      <img src={url} alt={cast.name} className="role-portrait" />
      {isPlaceholder && <span className="corner-tag">立绘待补</span>}
      <div className="role-meta">
        <b>{cast.name}</b>
        <span>{cast.role}</span>
        {cast.stance && <span className="role-stance">{cast.stance}</span>}
        {cast.influence != null && <span className="role-influence">影响力 {cast.influence}</span>}
      </div>
    </div>
  );
}

export function CastPanel({ members }: { members: CastMember[] }) {
  return (
    <aside className="cast-panel">
      <h2 className="panel-title">廷 臣</h2>
      <div className="cast-list">
        {members.map((c) => (
          <RoleCard key={c.id} cast={c} />
        ))}
      </div>
    </aside>
  );
}