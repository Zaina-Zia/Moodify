declare module 'spotify-preview-finder' {
  export interface FindOptions {
    title: string;
    artist: string;
    market?: string;
    limit?: number;
    // Allow extra fields the lib might accept
    [key: string]: any;
  }

  export type PreviewItem = any; // Use any to stay flexible with varying shapes

  export function findPreview(options: FindOptions): Promise<PreviewItem[] | null | undefined>;
  export function searchPreview(options: FindOptions): Promise<PreviewItem[] | null | undefined>;

  const defaultExport: ((options: FindOptions) => Promise<PreviewItem[] | null | undefined>) & {
    findPreview?: typeof findPreview;
    searchPreview?: typeof searchPreview;
    [key: string]: any;
  };

  export default defaultExport;
}
