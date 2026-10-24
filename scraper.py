import os
import requests
from bs4 import BeautifulSoup
from supabase import create_client, Client

# 1. Connect to Supabase using secrets set up in GitHub
SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY")

if not SUPABASE_URL or not SUPABASE_KEY:
    raise ValueError("Missing Supabase credentials in environment variables.")

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

def scrape_volunteer_opportunities():
    print("⚡ Starting VolunNet BC Scraper Pipeline...")
    
    # Target URL: Public Metro Vancouver / BC listings from VolunteerConnector
    url = "https://www.volunteerconnector.org/?pc=V6K&md=50&so=Newest"
    headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}
    
    response = requests.get(url, headers=headers)
    if response.status_code != 200:
        print(f"❌ Failed to fetch page. Status code: {response.status_code}")
        return

    soup = BeautifulSoup(response.text, "html.parser")
    listings = []

    # Parse listing cards on the page
    cards = soup.find_all("div", class_="card")
    for card in cards:
        title_tag = card.find("h3") or card.find("a")
        org_tag = card.find("div", class_="organization") or card.find("p")
        
        if not title_tag:
            continue
            
        title = title_tag.get_text(strip=True)
        organization = org_tag.get_text(strip=True) if org_tag else "Metro Vancouver Non-Profit"
        link = "https://www.volunteerconnector.org" + title_tag['href'] if title_tag.has_attr('href') else url
        
        # Structure payload matching our Supabase schema
        listings.append({
            "title": title,
            "organization": organization,
            "description": f"Real-time opportunity sourced via VolunNet BC pipeline for {organization}.",
            "city": "Vancouver / Metro Vancouver",
            "category": "Community Service",
            "hours_offered": 3,
            "application_url": link,
            "is_active": True
        })

    print(f"🔍 Found {len(listings)} opportunities. Ingesting to Supabase...")

    # Ingest data into Supabase table
    for item in listings:
        try:
            # Upsert/Insert listing into database
            data, count = supabase.table("listings").insert(item).execute()
            print(f"✅ Ingested: {item['title']}")
        except Exception as e:
            print(f"⚠️ Notice for {item['title']}: {e}")

if __name__ == "__main__":
    scrape_volunteer_opportunities()
