import { useEffect, useState } from "react";
import "./CountdownPage.css";

export function CountdownPage() {
  const [secondsRemaining, setSecondsRemaining] = useState<number | null>(null);

  useEffect(() => {
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
  }, []);

  useEffect(() => window.api.countdown.onTick(setSecondsRemaining), []);

  if (secondsRemaining === null) return null;

  return (
    <div className="countdown-root" onClick={() => window.api.countdown.cancel().catch(() => {})}>
      <span key={secondsRemaining} className="countdown-number">
        {secondsRemaining}
      </span>
      <span className="countdown-hint">Click to cancel</span>
    </div>
  );
}
