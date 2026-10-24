import os
import requests
from supabase import create_client, Client

# Get credentials from GitHub Secrets
SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY")

print("--- DIAGNOSTIC CHECK ---")
print(f"SUPABASE_URL present: {bool(SUPABASE_URL)}")
print(f"SUPABASE_KEY present: {bool(SUPABASE_KEY)}")

if not SUPABASE_URL or not SUPABASE_KEY:
    print("❌ ERROR: Missing Supabase secrets in GitHub Repository Settings!")
    exit(1)

try:
    supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)
    print("✅ Successfully initialized Supabase client.")
except Exception as e:
    print(f"❌ Failed to connect to Supabase: {e}")
    exit(1)

def main():
    print("⚡ Fetching opportunities from VolunteerConnector JSON API...")
    url = "https://www.volunteerconnector.org/api/search/"
    headers = {"User-Agent": "Mozilla/5.0"}
    
    try:
        response = requests.get(url, headers=headers, timeout=10)
        print(f"API Response Status Code: {response.status_code}")
        
        if response.status_code == 200:
            data = response.json()
            results = data.get("results", [])
            print(f"🔍 Found {len(results)} opportunities!")
            
            for item in results[:5]:  # Process first 5 items
                title = item.get("title", "Volunteer Opportunity")
                org_info = item.get("organization", {})
                org_name = org_info.get("name", "Community Non-Profit") if isinstance(org_info, dict) else "Community Non-Profit"
                link = item.get("url", "https://www.volunteerconnector.org")
                
                payload = {
                    "title": title,
                    "organization": org_name,
                    "description": "Opportunity ingested via VolunNet BC automated pipeline.",
                    "city": "Metro Vancouver",
                    "category": "Community Service",
                    "hours_offered": 3,
                    "application_url": link,
                    "is_active": True
                }
                
                try:
                    supabase.table("listings").insert(payload).execute()
                    print(f"✅ Ingested: {title}")
                except Exception as db_err:
                    print(f"⚠️ DB Notice for '{title}': {db_err}")
        else:
            print(f"❌ API call failed with code {response.status_code}")
            
    except Exception as e:
        print(f"❌ Script execution error: {e}")
        exit(1)

if __name__ == "__main__":
    main()
