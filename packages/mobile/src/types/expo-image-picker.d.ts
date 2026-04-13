/**
 * Minimal type declarations for expo-image-picker.
 * Full types available after `npx expo install expo-image-picker`.
 */
declare module 'expo-image-picker' {
  export interface ImagePickerAsset {
    uri: string;
    width: number;
    height: number;
    type?: 'image' | 'video';
    fileName?: string | null;
    fileSize?: number;
    mimeType?: string;
  }

  export interface ImagePickerResult {
    canceled: boolean;
    assets?: ImagePickerAsset[] | null;
  }

  export interface ImagePickerOptions {
    mediaTypes?: string[];
    quality?: number;
    allowsEditing?: boolean;
    allowsMultipleSelection?: boolean;
  }

  export function launchImageLibraryAsync(options?: ImagePickerOptions): Promise<ImagePickerResult>;
  export function launchCameraAsync(options?: ImagePickerOptions): Promise<ImagePickerResult>;
  export function requestMediaLibraryPermissionsAsync(): Promise<{ status: string; granted: boolean }>;
  export function requestCameraPermissionsAsync(): Promise<{ status: string; granted: boolean }>;
}
