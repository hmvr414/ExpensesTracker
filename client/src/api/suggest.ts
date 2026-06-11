import axios from 'axios';

export interface SuggestCategoryResponse {
  categoryId: number | null;
  categoryName?: string;
  color?: string;
  suggestedNewCategory?: string | null;
}

export async function suggestCategory(params: {
  store?: string;
  description?: string;
}): Promise<SuggestCategoryResponse> {
  const res = await axios.post<SuggestCategoryResponse>('/api/suggest/category', params);
  return res.data;
}
