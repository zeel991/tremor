import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement>;
const base = (p: P): P => ({
  width: 18,
  height: 18,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "square",
  strokeLinejoin: "miter",
  "aria-hidden": true,
  ...p,
});

export const IconHome = (p: P) => (
  <svg {...base(p)}>
    <path d="M4 11 12 4l8 7" />
    <path d="M6 10v10h12V10" />
  </svg>
);
export const IconMarkets = (p: P) => (
  <svg {...base(p)}>
    <path d="M4 6h16M4 12h16M4 18h16" />
  </svg>
);
export const IconWrite = (p: P) => (
  <svg {...base(p)}>
    <path d="M4 20h4L19 9l-4-4L4 16v4Z" />
    <path d="M13 7l4 4" />
  </svg>
);
export const IconPortfolio = (p: P) => (
  <svg {...base(p)}>
    <rect x="3" y="6" width="18" height="13" />
    <path d="M3 10h18" />
    <path d="M16 14.5h2" />
  </svg>
);
export const IconHedge = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 3l8 3v6c0 4.5-3.5 8-8 9-4.5-1-8-4.5-8-9V6l8-3Z" />
    <path d="M8.5 12.5l2.5 2.5 4.5-5" />
  </svg>
);
export const IconDocs = (p: P) => (
  <svg {...base(p)}>
    <path d="M5 4h9l5 5v11H5V4Z" />
    <path d="M14 4v5h5" />
    <path d="M8 13h8M8 17h6" />
  </svg>
);
export const IconCheck = (p: P) => (
  <svg {...base(p)}>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </svg>
);
export const IconX = (p: P) => (
  <svg {...base(p)}>
    <path d="M6 6l12 12M18 6 6 18" />
  </svg>
);
export const IconSpinner = (p: P) => (
  <svg {...base({ className: "spin", ...p })}>
    <path d="M12 3a9 9 0 1 0 9 9" />
  </svg>
);
export const IconExternal = (p: P) => (
  <svg {...base(p)}>
    <path d="M14 4h6v6M20 4l-9 9" />
    <path d="M18 14v6H4V6h6" />
  </svg>
);
export const IconCopy = (p: P) => (
  <svg {...base(p)}>
    <rect x="9" y="9" width="11" height="11" />
    <path d="M5 15V4h11" />
  </svg>
);
export const IconChevron = (p: P) => (
  <svg {...base(p)}>
    <path d="M6 9l6 6 6-6" />
  </svg>
);
export const IconArrow = (p: P) => (
  <svg {...base(p)}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </svg>
);
export const IconSwap = (p: P) => (
  <svg {...base(p)}>
    <path d="M9 4v16M9 20l-3-3M9 20l3-3" />
    <path d="M15 20V4M15 4l-3 3M15 4l3 3" />
  </svg>
);
export const IconWallet = (p: P) => (
  <svg {...base(p)}>
    <path d="M3 7h15v4" />
    <rect x="3" y="7" width="18" height="12" />
    <path d="M16 13h2" />
  </svg>
);
export const IconInfo = (p: P) => (
  <svg {...base(p)}>
    <rect x="3.5" y="3.5" width="17" height="17" />
    <path d="M12 11v5M12 8h.01" />
  </svg>
);
export const IconWarning = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 4 2.5 20h19L12 4Z" />
    <path d="M12 10v4M12 17h.01" />
  </svg>
);

/** Tremor mark: lime square with a seismograph trace. */
export const LogoMark = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
    <rect width="16" height="16" fill="#BAFE4E" />
    <path d="M2 8.5h2.5l1.5-4 2.5 7 2-5 1.2 2H14" fill="none" stroke="#0D0D0D" strokeWidth="1.4" strokeLinejoin="miter" />
  </svg>
);
