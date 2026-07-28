import type { Video } from "@shared/types/models";
import { StorageProvider } from "../../providers/storage/StorageProvider";

export const SearchService = {
  search(query: string): Promise<Video[]> {
    return StorageProvider.search(query);
  },
};
