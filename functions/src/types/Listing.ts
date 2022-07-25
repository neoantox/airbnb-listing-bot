export interface Listing {
  id: string;
  name: string;
  imageUrl: string | null;
  rating: string | null;
  price: {
    total: string;
    nightly: string;
  }
  rawResponse: any;
}
