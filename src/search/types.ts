export interface SearchResultItem {
  title: string;
  url: string;
  snippet: string;
  score?: number | undefined;
}

export interface SearchProvider {
  search(query: string, limit?: number): Promise<SearchResultItem[]>;
}
