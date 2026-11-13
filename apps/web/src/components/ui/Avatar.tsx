interface AvatarProps {
  initials: string;
  color?: string;
  size?: number;
}

const PALETTE = ['#6366F1', '#10B981', '#F59E0B', '#EC4899', '#0EA5E9', '#8B5CF6', '#14B8A6'];

export function Avatar({ initials, color, size = 36 }: AvatarProps) {
  const a = initials.codePointAt(0) ?? 0;
  const b = initials.codePointAt(1) ?? 0;
  const palette = PALETTE[(a + b) % PALETTE.length] ?? '#6366F1';
  const c = color ?? palette;
  return (
    <div
      className="rounded-full flex items-center justify-center font-display font-bold text-white text-[12px] shrink-0"
      style={{
        background: c,
        width: `${size}px`,
        height: `${size}px`,
      }}
    >
      {initials}
    </div>
  );
}
