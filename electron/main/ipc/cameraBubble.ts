import { ipcMain } from "electron";
import { Channels } from "@shared/constants/channels";
import type { CameraBubbleBounds, CameraBubbleConfig } from "@shared/types/models";
import {
  closeCameraBubbleWindow,
  getCameraBubbleBounds,
  isCameraBubbleWindowOpen,
  openCameraBubbleWindow,
  setCameraBubbleBounds,
  setCameraBubbleShape,
  setCameraBubbleShapeRegion,
  updateCameraBubbleConfig,
} from "../cameraBubbleWindow";

type RecordPageConfig = Pick<CameraBubbleConfig, "mirror" | "cameraDeviceId" | "blur">;
type BubbleShapeConfig = Pick<CameraBubbleConfig, "shape" | "roundedCorners" | "freeformResize">;

export function registerCameraBubbleIpc(): void {
  ipcMain.handle(Channels.cameraBubble.open, async (_event, config: RecordPageConfig): Promise<void> => {
    openCameraBubbleWindow(config);
  });

  ipcMain.handle(Channels.cameraBubble.close, async (): Promise<void> => {
    closeCameraBubbleWindow();
  });

  ipcMain.handle(Channels.cameraBubble.updateConfig, async (_event, config: RecordPageConfig): Promise<void> => {
    updateCameraBubbleConfig(config);
  });

  ipcMain.handle(Channels.cameraBubble.setShape, async (_event, shape: BubbleShapeConfig): Promise<void> => {
    setCameraBubbleShape(shape);
  });

  ipcMain.handle(
    Channels.cameraBubble.setShapeRegion,
    async (_event, rects: { x: number; y: number; width: number; height: number }[]): Promise<void> => {
      setCameraBubbleShapeRegion(rects);
    }
  );

  ipcMain.handle(Channels.cameraBubble.isOpen, async (): Promise<boolean> => isCameraBubbleWindowOpen());

  ipcMain.handle(
    Channels.cameraBubble.getBounds,
    async (): Promise<CameraBubbleBounds | null> => getCameraBubbleBounds()
  );

  ipcMain.handle(Channels.cameraBubble.setBounds, async (_event, bounds: CameraBubbleBounds): Promise<void> => {
    setCameraBubbleBounds(bounds);
  });
}
