import React, { useState, useEffect, useRef, useMemo } from 'react';

// --- Reusable SVG Icon Components ---
const SunIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
  </svg>
);

const MoonIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
  </svg>
);

const SearchIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8 text-sky-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
        <circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
);

const ClearIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6 text-slate-400 hover:text-sky-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
    </svg>
);


// --- Main Application Components ---

const ThemeToggle = () => {
  const [isDark, setIsDark] = useState(true);

  useEffect(() => {
    const savedTheme = localStorage.getItem('theme');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const initialIsDark = savedTheme ? savedTheme === 'dark' : prefersDark;
    setIsDark(initialIsDark);
  }, []);

  useEffect(() => {
    if (isDark) {
      document.documentElement.classList.add('dark');
      localStorage.setItem('theme', 'dark');
    } else {
      document.documentElement.classList.remove('dark');
      localStorage.setItem('theme', 'light');
    }
  }, [isDark]);

  return (
    <button
      onClick={() => setIsDark(!isDark)}
      className="fixed top-4 right-4 p-3 bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 rounded-full shadow-md z-10"
      aria-label="Toggle theme"
    >
      {isDark ? <SunIcon /> : <MoonIcon />}
    </button>
  );
};

const SearchBar = ({ onSearch, isSearching }) => {
  const [query, setQuery] = useState('');
  const inputRef = useRef(null);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (query.trim()) {
      onSearch(query.trim());
    }
  };
  
  const handleClear = () => {
      setQuery('');
      inputRef.current?.focus();
  };

  return (
    <form onSubmit={handleSubmit} className="relative w-full mb-12">
      <input
        ref={inputRef}
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        disabled={isSearching}
        className="w-full pl-6 pr-28 py-5 text-lg bg-white dark:bg-slate-800 border-2 border-slate-300 dark:border-slate-700 focus:border-sky-500 focus:ring-2 focus:ring-sky-500 rounded-full shadow-xl outline-none disabled:opacity-50"
        placeholder="Find a game..."
        required
      />
      {query && !isSearching && (
        <button type="button" onClick={handleClear} className="absolute top-1/2 -translate-y-1/2 right-20 p-2" aria-label="Clear search">
          <ClearIcon />
        </button>
      )}
      <button type="submit" disabled={isSearching} className="absolute right-4 top-1/2 -translate-y-1/2" aria-label="Search">
        <SearchIcon />
      </button>
    </form>
  );
};

const ResultCard = ({ siteData }) => {
  const { site_name, result, search_link } = siteData;
  return (
    <div className="bg-white dark:bg-slate-800 p-5 sm:p-6 rounded-xl shadow-lg border border-slate-200 dark:border-slate-700 animate-fade-in-up">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between mb-3">
        <h3 className="text-xl font-semibold text-slate-700 dark:text-slate-200 mb-2 sm:mb-0">{site_name}</h3>
        {search_link && (
          <a href={search_link} target="_blank" rel="noopener noreferrer" className="text-xs bg-slate-200 hover:bg-slate-300 dark:bg-slate-700 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-300 font-medium py-1.5 px-4 rounded-full transition whitespace-nowrap">
            All Results
          </a>
        )}
      </div>
      {result ? (
        <a href={result.link} target="_blank" rel="noopener noreferrer" className="block mb-1.5 group">
          <h4 className="text-lg font-medium text-sky-600 dark:text-sky-400 group-hover:underline truncate" title={result.title}>
            {result.title}
          </h4>
        </a>
      ) : (
        <p className="text-sm text-slate-500 dark:text-slate-400">No specific result found for this site.</p>
      )}
    </div>
  );
};

const Footer = () => (
    <footer className="w-full text-center p-4 text-sm text-slate-500 dark:text-slate-400">
        <p>Game Search &copy; {new Date().getFullYear()}.</p>
        <p className="mt-1 text-xs">This tool attempts to fetch top results. Data accuracy depends on external sites.</p>
    </footer>
);


// --- The Main App Component ---
export default function App() {
  const [results, setResults] = useState([]);
  const [searchStatus, setSearchStatus] = useState('idle'); // 'idle', 'searching', 'cached', 'completed'
  const [searchQuery, setSearchQuery] = useState('');
  const eventSourceRef = useRef(null);

  const handleSearch = (query) => {
    // Close any existing connection
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }
    
    setResults([]);
    setSearchQuery(query);
    setSearchStatus('searching');

    // --- FIX: Use process.env instead of import.meta.env ---
    // This is the standard, cross-compatible way to access environment variables
    // in modern JavaScript bundlers like Vite, resolving the compilation warning.
    const apiUrl = process.env.VITE_API_URL || 'http://localhost:5000';
    const sseUrl = `${apiUrl}/api/search/stream?query=${encodeURIComponent(query)}`;
    
    const newEventSource = new EventSource(sseUrl);
    eventSourceRef.current = newEventSource;

    newEventSource.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.status) {
        if (data.status === 'completed') {
            setSearchStatus('completed');
            newEventSource.close();
        } else {
            setSearchStatus(data.status); // 'searching' or 'cached'
        }
      } else {
        // Use a functional update to prevent race conditions
        setResults(prevResults => [...prevResults, data]);
      }
    };

    newEventSource.onerror = (err) => {
      console.error("EventSource failed:", err);
      setSearchStatus('completed'); // Mark as completed on error to re-enable search
      newEventSource.close();
    };
  };
  
  const isSearching = searchStatus === 'searching' || searchStatus === 'cached';

  // Memoize the sorted results to prevent re-sorting on every render
  const sortedResults = useMemo(() => {
    return [...results].sort((a, b) => a.site_name.localeCompare(b.site_name));
  }, [results]);

  const getStatusMessage = () => {
      if (searchStatus === 'idle' || !searchQuery) return null;
      if (searchStatus === 'searching') return 'Searching live...';
      if (searchStatus === 'cached') return 'Streaming fast results from cache...';
      if (searchStatus === 'completed' && results.length > 0) return `Search complete. Found ${results.length} result${results.length !== 1 ? 's' : ''}.`;
      if (searchStatus === 'completed' && results.length === 0) return 'No results found for this query.';
      return null;
  }

  return (
    <div className="bg-slate-100 dark:bg-slate-900 text-slate-900 dark:text-slate-200 min-h-screen flex flex-col items-center selection:bg-sky-500 selection:text-white">
      <ThemeToggle />
      <main className="flex flex-col items-center w-full px-4 pb-10 flex-grow transition-all duration-300">
        <div className={`w-full max-w-2xl text-center transition-all duration-500 ease-in-out ${searchQuery ? 'mt-16' : 'my-auto'}`}>
            <h1 className="text-5xl md:text-6xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-sky-500 to-blue-600 mb-10">
                Game Search
            </h1>
            <SearchBar onSearch={handleSearch} isSearching={isSearching} />
        </div>
        
        {searchQuery && (
            <div className="w-full max-w-3xl">
                <div className="mt-6 mb-4 text-center text-slate-600 dark:text-slate-400 h-6">
                    {getStatusMessage()}
                </div>
                <div className="space-y-5">
                    {sortedResults.map(siteData => (
                        <ResultCard key={siteData.site_id} siteData={siteData} />
                    ))}
                </div>
            </div>
        )}
      </main>
      <Footer />
    </div>
  );
}
