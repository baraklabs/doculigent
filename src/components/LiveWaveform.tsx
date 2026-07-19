import { useEffect, useRef } from "react";

interface LiveWaveformProps {
  analyser: AnalyserNode | null;
}

/** Real-time mic waveform — reads raw amplitude samples off the AnalyserNode every frame
 *  and draws them as a line, no faking/interpolating between "levels". */
export function LiveWaveform({ analyser }: LiveWaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !analyser) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const data = new Uint8Array(analyser.fftSize);
    let raf = 0;

    function draw() {
      raf = requestAnimationFrame(draw);
      analyser!.getByteTimeDomainData(data);

      const { width, height } = canvas!;
      ctx!.clearRect(0, 0, width, height);
      ctx!.lineWidth = 2;
      ctx!.strokeStyle = "#5b4bf5";
      ctx!.beginPath();

      const step = width / data.length;
      for (let i = 0; i < data.length; i++) {
        const y = (data[i] / 255) * height;
        const x = i * step;
        if (i === 0) ctx!.moveTo(x, y);
        else ctx!.lineTo(x, y);
      }
      ctx!.stroke();
    }
    draw();

    return () => cancelAnimationFrame(raf);
  }, [analyser]);

  return <canvas ref={canvasRef} className="live-waveform" width={640} height={72} />;
}
