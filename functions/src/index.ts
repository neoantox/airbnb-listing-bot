import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import * as R from "ramda";
import fetch from "node-fetch";
import {Telegraf} from "telegraf";
import QuerySnapshot = admin.firestore.QuerySnapshot;
import FieldValue = admin.firestore.FieldValue;

import {Listing, SearchEntry} from "./types";
import {sleep} from "./utils";

admin.initializeApp();

const firestore = admin.firestore();
const bot = new Telegraf(process.env.TELEGRAM_TOKEN as string);

// noinspection JSUnusedGlobalSymbols
export const checkListings = functions
    .region("europe-west3")
    .runWith({
      timeoutSeconds: 540,
      maxInstances: 1,
      secrets: ["TELEGRAM_TOKEN", "AIRBNB_API_KEY"],
    })
    .pubsub.schedule("every 5 minutes")
    .onRun(async () => {
      const snapshot = await firestore.collection("searches").get() as QuerySnapshot<SearchEntry>;
      const snapshotDocs = snapshot.docs;

      for (const [index, searchSnapshot] of snapshotDocs.entries()) {
        const search = searchSnapshot.data();
        const data = await loadListings(search);
        const listingIds = data.map((item) => item.id);
        const knownListingIds = search.knownListings ?? [];
        const newListingIds = R.difference(listingIds, knownListingIds);
        const newListings = data.filter((item) => newListingIds.includes(item.id));

        functions.logger.info(`Total listings: ${listingIds.length}, new listings: ${newListingIds.length}`);

        for (const [listingIndex, listing] of newListings.entries()) {
          functions.logger.info(`Processing listing ${listing.id}`, listing);
          await sendTelegramMessage(listing, search);

          if (listingIndex !== newListings.length - 1) { // skip last iteration
            await sleep(3000);
          }
        }

        if (newListingIds.length > 0) {
          await searchSnapshot.ref.update({
            knownListings: FieldValue.arrayUnion(...newListingIds),
          });
        }

        if (index !== snapshotDocs.length - 1) { // skip last iteration
          await sleep(15000);
        }
      }
    });

async function loadListings(search: SearchEntry): Promise<Listing[]> {
  const url = "https://www.airbnb.com/api/v3/ExploreSections";
  const headers = {
    "X-Airbnb-API-Key": process.env.AIRBNB_API_KEY as string,
  };
  const queryParams = {
    operationName: "ExploreSections",
    locale: "en",
    currency: search.currency,
    variables: JSON.stringify({
      exploreRequest: {
        metadataOnly: false,
        version: "1.8.3",
        itemsPerGrid: 40,
        refinementPaths: ["/homes"],
        ...search.filters,
      },
    }),
    extensions: JSON.stringify({
      persistedQuery: {
        version: 1,
        sha256Hash: "a4f62dd4a0c881ddc9a3a00bc376e15c3fd1b10e6bc0a7c38d48f048a20b6c17",
      },
    }),
  };
  const queryParamsString = new URLSearchParams(queryParams).toString();

  const resp = await fetch(url + "?" + queryParamsString, {headers});
  const sections = (await resp.json())?.data?.presentation?.explore?.sections?.sections ?? [];
  for (const section of sections) {
    if (section.section?.child?.section?.__typename === "ExploreListingsSection") {
      const items = section.section.child?.section?.items ?? [];
      return items.map((item: any): Listing => ({
        id: item.listing.id as string,
        name: item.listing.name as string,
        imageUrl: item.listing.contextualPictures?.map((picture: any) => picture.picture)?.[0] as string | null,
        rating: item.listing.avgRatingLocalized ?? item.listing.avgRating,
        price: {
          total: item.pricingQuote.structuredStayDisplayPrice.secondaryLine.priceString,
          nightly: item.pricingQuote.structuredStayDisplayPrice.primaryLine.priceString,
        },
        rawResponse: item,
      }));
    }
  }
  throw new Error("Unable to find listings");
}

function getRoomUrl(id: string, search: SearchEntry) {
  const queryParams = new URLSearchParams({
    currency: search.currency,
    check_in: search.filters.checkin,
    check_out: search.filters.checkout,
    adults: search.filters.adults.toString(),
  }).toString();

  return `https://www.airbnb.com/rooms/${id}?${queryParams}`;
}

async function sendTelegramMessage(listing: Listing, search: SearchEntry) {
  const messageLines = [
    `<b><a href="${getRoomUrl(listing.id, search)}">${listing.name}</a></b>`,
    "",
    `💰 <b>${listing.price.total} total</b> (${listing.price.nightly} per night)`,
    `⭐️ ${listing.rating ?? "No rating"}`,
    "",
    `ID: ${listing.id}`,
  ];
  const message = messageLines.join("\n");

  if (listing.imageUrl) {
    await bot.telegram.sendPhoto(search.chatId, listing.imageUrl, {
      caption: message,
      parse_mode: "HTML",
    });
  } else {
    await bot.telegram.sendMessage(search.chatId, message, {
      parse_mode: "HTML",
    });
  }
}
