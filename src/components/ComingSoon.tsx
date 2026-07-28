import "./ComingSoon.css";

interface ComingSoonProps {
  icon: string;
  title: string;
  subtitle: string;
}

export function ComingSoon({ icon, title, subtitle }: ComingSoonProps) {
  return (
    <div className="coming-soon">
      <div className="coming-soon-orb">
        <span className="coming-soon-icon">{icon}</span>
      </div>
      <h1 className="coming-soon-title">{title}</h1>
      <p className="coming-soon-subtitle">{subtitle}</p>
      <span className="coming-soon-badge">Coming Soon</span>
    </div>
  );
}
