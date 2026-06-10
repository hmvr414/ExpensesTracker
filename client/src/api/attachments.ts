import axios from 'axios';

export interface AttachmentResponse {
  id: number;
  movement_id: number | null;
  file_name: string;
  file_path: string;
  mime_type: string;
  url: string;
  created_at: string;
}

export async function createAttachment(file: File, movementId?: number): Promise<AttachmentResponse> {
  const formData = new FormData();
  formData.append('file', file);
  if (movementId != null) {
    formData.append('movement_id', String(movementId));
  }
  const res = await axios.post<AttachmentResponse>('/api/attachments', formData);
  return res.data;
}

export async function deleteAttachment(id: number): Promise<void> {
  await axios.delete(`/api/attachments/${id}`);
}
