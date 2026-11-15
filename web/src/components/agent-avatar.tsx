export function AgentAvatar({ name, size = 32 }: { name: string; size?: number }) {
  const hue = [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-white"
      style={{
        width: size,
        height: size,
        background: `linear-gradient(135deg, oklch(0.62 0.15 ${hue}), oklch(0.48 0.17 ${(hue + 50) % 360}))`,
      }}
    >
      {name.trim().slice(0, 1).toUpperCase()}
    </div>
  );
}
