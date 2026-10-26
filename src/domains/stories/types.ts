// The story rows the header and the dashboard read.

export interface Story {
  id: string;
  title: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

// One copy of the database, as the backups dialog lists it.
export interface BackupInfo {
  file_name: string;
  created_at: string;
  size_bytes: number;
}
