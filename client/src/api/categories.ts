import axios from 'axios';

export interface ResolvedCategory {
  id: number;
  name: string;
  color: string | null;
  created: boolean;
}

export interface Category {
  id: number;
  name: string;
  color: string | null;
  icon: string | null;
  movement_count: number;
  created_at: string;
}

export interface CreateCategoryInput {
  name: string;
  color?: string;
  icon?: string;
}

export interface UpdateCategoryInput {
  name?: string;
  color?: string;
  icon?: string;
}

export async function getCategories(): Promise<Category[]> {
  const res = await axios.get<Category[]>('/api/categories');
  return res.data;
}

export async function createCategory(input: CreateCategoryInput): Promise<Category> {
  const res = await axios.post<Category>('/api/categories', input);
  return res.data;
}

export async function updateCategory(id: number, input: UpdateCategoryInput): Promise<Category> {
  const res = await axios.put<Category>(`/api/categories/${id}`, input);
  return res.data;
}

export async function deleteCategory(id: number): Promise<void> {
  await axios.delete(`/api/categories/${id}`);
}
