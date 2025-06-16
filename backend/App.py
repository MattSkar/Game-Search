import os
import json
import re
import logging
from urllib.parse import urljoin, quote_plus

# --- Modern Asynchronous & Caching Imports ---
import httpx  # Modern, async replacement for 'requests'
import redis # For caching results
import anyio # To run async functions within Flask

# --- Flask and Environment Imports ---
from flask import Flask, request, Response, jsonify
from flask_cors import CORS
from dotenv import load_dotenv

# --- Standard Scraping Imports ---
from bs4 import BeautifulSoup
from selenium import webdriver
from selenium.webdriver.chrome.service import Service as ChromeService
from selenium.webdriver.chrome.options import Options as ChromeOptions
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.common.exceptions import TimeoutException, WebDriverException
from webdriver_manager.chrome import ChromeDriverManager

# --- Initial Setup ---
load_dotenv() # Load environment variables from .env file

# --- Flask App Initialization ---
app = Flask(__name__)
# Load CORS origins from environment variables for security
CORS(app, origins=os.getenv('CORS_ORIGIN', '*').split(','))

# --- Redis Cache Connection ---
try:
    redis_client = redis.from_url(
        os.getenv('REDIS_URL'),
        decode_responses=True # Decode responses to UTF-8 automatically
    )
    redis_client.ping() # Check if the connection is successful
    print("Successfully connected to Redis.")
except redis.exceptions.ConnectionError as e:
    print(f"Could not connect to Redis: {e}. Caching will be disabled.")
    redis_client = None

# --- Configuration Loading ---
def load_sites_config():
    """Loads scraper configurations from the sites.json file."""
    config_path = os.path.join(os.path.dirname(__file__), 'config', 'sites.json')
    with open(config_path, 'r', encoding='utf-8') as f:
        config_data = json.load(f)
        # Sort the config alphabetically by name for consistent frontend display
        config_data.sort(key=lambda x: x['name'])
        return config_data
SITES_CONFIG = load_sites_config()


# --- Logging Setup (Simplified for Brevity) ---
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')


# --- Core Scraping Logic ---

def clean_game_title(title):
    if not title: return title
    # Special case for RexaGames
    if 'METAL' in title:
        title = title.replace('METAL ', '').strip()
    cleaned_title = re.sub(r'free download|download free', '', title, flags=re.IGNORECASE)
    cleaned_title = re.sub(r'\b(?<!^)(download)\b', '', cleaned_title, flags=re.IGNORECASE)
    return ' '.join(cleaned_title.split()).strip()

def contains_all_terms(text, search_terms):
    if not text or not search_terms: return False
    cleaned_text_no_spaces = re.sub(r'[^\w]', '', text.lower())
    for term in search_terms:
        term_no_spaces = re.sub(r'[^\w]', '', term.lower())
        if term_no_spaces not in cleaned_text_no_spaces:
            return False
    return True

async def fetch_static_site(client, site_config, search_url):
    """Asynchronously fetches content from a static website using httpx."""
    headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/98.0.4758.82 Safari/537.36'}
    try:
        response = await client.get(search_url, headers=headers, timeout=15.0, follow_redirects=True)
        response.raise_for_status()
        return response.text
    except httpx.RequestError as e:
        logging.error(f"HTTPX Error for {site_config['name']}: {e}")
        return None

def fetch_js_site(site_config, search_url):
    """Fetches content from a JS-heavy site using Selenium (runs synchronously)."""
    options = ChromeOptions()
    options.add_argument("--headless")
    options.add_argument("--no-sandbox")
    options.add_argument("--disable-dev-shm-usage")
    options.add_argument("--disable-gpu")
    options.add_argument("--log-level=3")
    driver = None
    try:
        service = ChromeService(ChromeDriverManager().install())
        driver = webdriver.Chrome(service=service, options=options)
        driver.get(search_url)
        if site_config.get('wait_for_selector'):
            WebDriverWait(driver, 15).until(EC.presence_of_element_located((By.CSS_SELECTOR, site_config['wait_for_selector'])))
        return driver.page_source
    except Exception as e:
        logging.error(f"Selenium Error for {site_config['name']}: {e}")
        return None
    finally:
        if driver:
            driver.quit()

def parse_html_and_extract(page_html, site_config, search_url, query):
    """Parses HTML to find and validate a search result based on JSON config."""
    if not page_html: return None
    try:
        soup = BeautifulSoup(page_html, 'html.parser')
        item_tag = soup.select_one(site_config['result_item_selector'])
        if not item_tag: return None

        # Extract title based on config
        title_conf = site_config['title_from_item']
        title_tag = item_tag.select_one(title_conf['selector']) if title_conf.get('selector') else item_tag
        title = ""
        if title_tag:
            if title_conf['method'] == 'text':
                title = title_tag.get_text(strip=True)
            elif title_conf['method'] in ['alt', 'title']:
                title = title_tag.get(title_conf['method'], '')
        
        # Extract link based on config
        link_conf = site_config['link_from_item']
        link_tag = item_tag.select_one(link_conf['selector']) if link_conf.get('selector') else item_tag
        link = link_tag.get(link_conf['method']) if link_tag and link_conf.get('method') else None
        
        if not title or not link: return None

        # Clean and validate
        cleaned_title = clean_game_title(title)
        search_terms = [term.strip() for term in query.split() if term.strip()]
        if not contains_all_terms(cleaned_title, search_terms):
            return None

        # Ensure link is absolute
        link = urljoin(search_url, link)

        return {
            'site_id': site_config['id'],
            'site_name': site_config['name'],
            'result': {'title': cleaned_title, 'link': link},
            'search_link': search_url
        }
    except Exception as e:
        logging.error(f"Parsing error for {site_config['name']}: {e}")
        return None

# --- Main API Endpoint ---
@app.route('/api/search/stream')
async def search_api_stream():
    query = request.args.get('query')
    if not query:
        return jsonify({'error': 'Query parameter is required'}), 400

    async def event_stream():
        """The main async generator for handling the search and streaming."""
        cache_key = f"search:{query.lower().strip()}"
        
        # 1. --- Check Cache First ---
        if redis_client:
            try:
                cached_results = redis_client.lrange(cache_key, 0, -1)
                if cached_results:
                    logging.info(f"CACHE HIT for query: '{query}'")
                    yield f"data: {json.dumps({'status': 'cached'})}\n\n"
                    for result in cached_results:
                        yield f"data: {result}\n\n"
                    yield f"data: {json.dumps({'status': 'completed'})}\n\n"
                    return
            except redis.exceptions.RedisError as e:
                logging.error(f"Redis error when checking cache: {e}")

        logging.info(f"CACHE MISS for query: '{query}'. Starting live scrape.")
        yield f"data: {json.dumps({'status': 'searching'})}\n\n"

        # 2. --- Perform Live Scraping Concurrently ---
        async with httpx.AsyncClient() as client:
            # Use a task group to manage concurrent scraping tasks
            async with anyio.create_task_group() as tg:
                for site in SITES_CONFIG:
                    
                    async def scrape_site(current_site):
                        """Async closure to scrape a single site."""
                        search_url = current_site['search_url_template'].format(query=quote_plus(query))
                        if current_site.get('js_required', False):
                            # Run synchronous Selenium code in a separate thread
                            page_html = await anyio.to_thread.run_sync(fetch_js_site, current_site, search_url)
                        else:
                            page_html = await fetch_static_site(client, current_site, search_url)
                        
                        result = parse_html_and_extract(page_html, current_site, search_url, query)
                        
                        if result:
                            result_json = json.dumps(result)
                            yield f"data: {result_json}\n\n"
                            # 3. --- Cache the Result ---
                            if redis_client:
                                try:
                                    redis_client.rpush(cache_key, result_json)
                                except redis.exceptions.RedisError as e:
                                    logging.error(f"Redis error when caching result: {e}")
                    
                    # Start a new task for each site
                    tg.start_soon(scrape_site, site)
        
        # 4. --- Finalize Stream ---
        if redis_client:
            try:
                # Set an expiration on the cache key so it doesn't live forever
                redis_client.expire(cache_key, 3600) # Expire after 1 hour
            except redis.exceptions.RedisError as e:
                logging.error(f"Redis error setting expiration: {e}")

        yield f"data: {json.dumps({'status': 'completed'})}\n\n"

    return Response(event_stream(), mimetype='text/event-stream')


# --- Main Execution Block (for local testing) ---
if __name__ == '__main__':
    # Use port 5000 for the backend API
    app.run(host='0.0.0.0', port=5000, debug=True)
