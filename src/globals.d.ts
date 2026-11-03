// File System Access API members Chromium ships that the TypeScript DOM
// library does not declare yet.

type PermissionMode = { mode?: 'read' | 'readwrite' }

interface FileSystemHandle {
  queryPermission(options?: PermissionMode): Promise<PermissionState>
  requestPermission(options?: PermissionMode): Promise<PermissionState>
}

interface DirectoryPickerOptions extends PermissionMode {
  id?: string
  startIn?: 'pictures' | 'documents' | 'desktop' | FileSystemHandle
}

interface Window {
  showDirectoryPicker(
    options?: DirectoryPickerOptions
  ): Promise<FileSystemDirectoryHandle>
}

interface DataTransferItem {
  getAsFileSystemHandle(): Promise<FileSystemHandle | null>
}
