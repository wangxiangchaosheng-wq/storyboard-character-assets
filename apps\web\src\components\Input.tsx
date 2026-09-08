/**
 * 底部 · 决策栏：AI 生成的可选行动按钮 + 自由指令输入。
 * 点按钮 → onDecide(opt.key)；输入自由文本回车/发布 → onDecide('own', text)。
 */
import { useState } from 'react';
import type { GameOption } from '@sim/contracts';
import { useAsset } from '../assets/useAsset.ts';

interface InputBarProps {
  options: GameOption[];
  onDecide: (option: string, text?: string) => void;
  disabled?: boolean;
  turn: number;
  totalRounds: number;
}

export function InputBar({ options, onDecide, disabled, turn, totalRounds }: InputBarProps) {
  const [text, setText] = useState('');
  const skin = useAsset('ui/input-req');
  const btn = useAsset('ui/btn-action');

  const submitOwn = () => {
    const v = text.trim();
    if (!v || disabled) return;
    onDecide('own', v);
    setText('');
  };

  return (
    <footer className="input-bar">
      <div className="option-row">
        {options.map((o) => (
          <button
            key={o.key}
            className={`option-btn ${disabled ? 'disabled' : ''}`}
            title={o.hint}
            onClick={() => onDecide(o.key)}
            disabled={disabled}
          >
            {o.title}
          </button>
        ))}
      </div>
      <div className="command-row">
        <input
          className="command-input"
          style={skin.isPlaceholder ? undefined : { backgroundImage: `url(${skin.url})` }}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="亦可发号施令：魏延，率精兵五千出子午谷…"
          onKeyDown={(e) => e.key === 'Enter' && submitOwn()}
          disabled={disabled}
        />
        <button
          className="action-btn"
          style={btn.isPlaceholder ? undefined : { backgroundImage: `url(${btn.url})` }}
          onClick={submitOwn}
          disabled={disabled}
        >
          {disabled ? '推演中…' : `决 断 · ${String(turn).padStart(2, '0')}/${String(totalRounds).padStart(2, '0')}`}
        </button>
      </div>
    </footer>
  );
}