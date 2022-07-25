export interface SearchEntry {
  chatId: string;
  currency: string;
  filters: {
    checkin: string;
    checkout: string;
    adults: number;
  } & Record<string, any>;
  knownListings?: string[];
}
