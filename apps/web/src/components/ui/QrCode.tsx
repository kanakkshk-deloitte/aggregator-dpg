import type { JSX } from 'react';

interface QrCodeProps {
  size?: number;
}

export function QrCode({ size = 180 }: QrCodeProps) {
  const cells: JSX.Element[] = [];
  const seed = (i: number, j: number) => (i * 7 + j * 13 + i * j) % 5 > 1;
  for (let i = 0; i < 21; i++) {
    for (let j = 0; j < 21; j++) {
      if (seed(i, j)) {
        cells.push(
          <rect
            key={`${i}-${j}`}
            x={j * 6}
            y={i * 6}
            width="5"
            height="5"
            fill="#0B1020"
            rx="0.5"
          />,
        );
      }
    }
  }
  const finder = (x: number, y: number) => (
    <g key={`f${x}-${y}`}>
      <rect x={x} y={y} width="38" height="38" fill="#0B1020" />
      <rect x={x + 5} y={y + 5} width="28" height="28" fill="#fff" />
      <rect x={x + 10} y={y + 10} width="18" height="18" fill="#0B1020" />
    </g>
  );
  return (
    <svg width={size} height={size} viewBox="0 0 126 126" className="rounded-md">
      <rect width="126" height="126" fill="#fff" />
      {cells}
      <rect x="0" y="0" width="42" height="42" fill="#fff" />
      <rect x="84" y="0" width="42" height="42" fill="#fff" />
      <rect x="0" y="84" width="42" height="42" fill="#fff" />
      {finder(2, 2)}
      {finder(86, 2)}
      {finder(2, 86)}
      <rect x="51" y="51" width="24" height="24" rx="5" fill="#10B981" />
      <text
        x="63"
        y="68"
        textAnchor="middle"
        fontFamily="Plus Jakarta Sans"
        fontWeight="800"
        fontSize="10"
        fill="white"
      >
        BD
      </text>
    </svg>
  );
}
