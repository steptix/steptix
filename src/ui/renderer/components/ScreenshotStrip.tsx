import React, { useState } from 'react';
import { ScreenshotModal } from './ScreenshotModal';

interface ScreenshotStripProps {
  screenshots: string[];
}

export function ScreenshotStrip({ screenshots }: ScreenshotStripProps) {
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);

  if (screenshots.length === 0) return null;

  return (
    <>
      <div className="screenshot-strip">
        {screenshots.map((url, i) => (
          <img
            key={i}
            className="screenshot-thumb"
            src={url}
            alt={`Screenshot ${i + 1}`}
            onClick={() => setSelectedIndex(i)}
          />
        ))}
      </div>
      {selectedIndex !== null && (
        <ScreenshotModal
          src={screenshots[selectedIndex]}
          onClose={() => setSelectedIndex(null)}
        />
      )}
    </>
  );
}
