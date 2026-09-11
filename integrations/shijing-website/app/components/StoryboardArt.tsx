import type { Storyboard } from '../lib/scene-assets';

// Coordinates are copied from Group 18.svg. The path bounds are 452 × 801.5.
// Keep blending on the outer group so it sees the bamboo backdrop.
export default function StoryboardArt({ story }: { story: Storyboard }) {
  return (
    <svg className="storyboard-art" viewBox="983 74 452 801.5" role="img" aria-label={`${story.location}：${story.title}`}>
      <defs>
        <mask id="storyboard-mask" maskUnits="userSpaceOnUse" x="982" y="73" width="454" height="803" style={{ maskType: 'alpha' }}>
          <path d="M983 75.5L984.5 875.5H1435L1419 74L983 75.5Z" fill="#D9D9D9" stroke="black" />
        </mask>
      </defs>
      <g mask="url(#storyboard-mask)">
        <image href={story.image} x="977" y="70" width="456" height="809" preserveAspectRatio="xMidYMid slice" />
      </g>
    </svg>
  );
}
