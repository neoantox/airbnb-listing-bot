import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import * as R from "ramda";
import fetch from "node-fetch";
import {Telegraf} from "telegraf";
import QuerySnapshot = admin.firestore.QuerySnapshot;
import FieldValue = admin.firestore.FieldValue;

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

      for (const searchSnapshot of snapshot.docs) {
        const search = searchSnapshot.data();
        const data = await loadListings(search);
        const listingIds = data.map((item: any) => item.listing.id);
        const knownListingIds = search.knownListings ?? [];
        const newListingIds = R.difference(listingIds, knownListingIds);
        const newListings = data.filter((item: any) => newListingIds.includes(item.listing.id));

        functions.logger.info(`Total listings: ${listingIds.length}, new listings: ${newListingIds.length}`);

        for (const listing of newListings) {
          functions.logger.info(`Processing listing ${listing.listing.id}`, listing);
          await sendTelegramMessage(listing, search);
          await sleep(3000);
        }

        if (newListingIds.length > 0) {
          await searchSnapshot.ref.update({
            knownListings: FieldValue.arrayUnion(...newListingIds),
          });
        }
        await sleep(15000);
      }
    });

interface SearchEntry {
  chatId: string;
  currency: string;
  filters: Record<string, any> & { checkin: string; checkout: string };
  knownListings?: string[];
}

async function loadListings(search: SearchEntry) {
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
      return section.section.child?.section?.items ?? [];
    }
  }
  throw new Error("Unable to find listings");
}

function getRoomUrl(id: string, search: SearchEntry) {
  const queryParams = new URLSearchParams({
    currency: search.currency,
    check_in: search.filters.checkin,
    check_out: search.filters.checkout,
    adults: search.filters.adults,
  }).toString();

  return `https://www.airbnb.com/rooms/${id}?${queryParams}`;
}

async function sendTelegramMessage(listing: any, search: SearchEntry) {
  const image: string = listing.listing.contextualPictures?.map((picture: any) => picture.picture)?.[0];
  const messageLines = [
    `<b><a href="${getRoomUrl(listing.listing.id, search)}">${listing.listing.name}</a></b>`,
    "",
    `💰 <b>${listing.pricingQuote.structuredStayDisplayPrice.secondaryLine.accessibilityLabel}</b>` +
    ` (${listing.pricingQuote.structuredStayDisplayPrice.primaryLine.accessibilityLabel})`,
    `⭐️ ${listing.listing.avgRatingLocalized ?? listing.listing.avgRating ?? "No rating"}`,
    "",
    `ID: ${listing.listing.id}`,
  ];
  const message = messageLines.join("\n");

  if (image) {
    await bot.telegram.sendPhoto(search.chatId, image, {
      caption: message,
      parse_mode: "HTML",
    });
  } else {
    await bot.telegram.sendMessage(search.chatId, message, {
      parse_mode: "HTML",
    });
  }
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
