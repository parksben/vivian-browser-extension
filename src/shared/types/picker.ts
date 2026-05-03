// Picker element shape. Produced by content script (captureElement) and
// consumed by the sidebar's attachment UI. The `screenshot` field is enriched
// by the background script after it receives an `element_picked_capture`
// message — the content script only fills the other fields.

export interface PickRect {
  x: number;
  y: number;
  w: number;
  h: number;
  dpr: number;
}

export interface CapturedElement {
  tag: string;
  id: string;
  classes: string[];
  text: string;
  selector: string;
  rect: PickRect;
}

export interface PickedElement extends CapturedElement {
  /** base64 JPEG data URL cropped to the element's bounding box */
  screenshot?: string;
}
