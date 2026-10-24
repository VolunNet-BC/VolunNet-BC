import os
import requests
from supabase import create_client, Client

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY")

if not SUPABASE_URL or not SUPABASE_KEY:
    raise ValueError("Missing Supabase credentials in environment variables.")

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

def fetch_and_ingest_opportunities():
    print("⚡ Starting VolunNet BC API Ingestion Pipeline...")
    
    # VolunteerConnector Free Public JSON Search API
    api_url = "https://www.volunteerconnector.org/api/search/"
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    }
    
    response = requests.get(api_url, headers=headers)
    if response.status_code != 200:
        print(f"❌ Failed to fetch API. Status code: {response.status_code}")
        return

    data = response.json()
    results = data.get("results", [])
    print(f"🔍 Retrieved {len(results)} opportunities from VolunteerConnector API.")

    for item in results:
        title = item.get("title", "Volunteer Position")
        org_data = item.get("organization", {})
        org_name = org_data.get("name", "Metro Vancouver Non-Profit") if isinstance(org_data, dict) else "Community Partner"
        link = item.get("url", "https://www.volunteerconnector.org")
        
        # Prepare object for Supabase schema
        payload = {
            "title": title,
            "organization": org_name,
            "description": item.get("description", "Community opportunity sourced via VolunNet BC pipeline.")[:300],
            "city": "Metro Vancouver",
            "category": "Youth & Community",
            "hours_offered": 3,
            "application_url": link,
            "is_active": True
        }
        
        try:
            supabase.table("listings").insert(payload).execute()
            print(f"✅ Ingested: {title}")
        except Exception as e:
            print(f"⚠️ Notice for {title}: {e}")

if __name__ == "__main__":
    fetch_and_ingest_opportunities()
