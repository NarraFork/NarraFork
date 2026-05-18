package updateserver

import (
	"encoding/json"
	"sort"
	"strings"
	"sync"
)

type ReleaseCache struct {
	mu      sync.RWMutex
	storage *LocalStorage
	cache   map[string]map[string]ReleaseMeta
	loading map[string]*sync.Cond
}

func NewReleaseCache(storage *LocalStorage) *ReleaseCache {
	return &ReleaseCache{
		storage: storage,
		cache:   map[string]map[string]ReleaseMeta{},
		loading: map[string]*sync.Cond{},
	}
}

func (c *ReleaseCache) ensureProduct(product string) error {
	c.mu.RLock()
	_, ok := c.cache[product]
	c.mu.RUnlock()
	if ok {
		return nil
	}
	return c.loadProduct(product)
}

func (c *ReleaseCache) loadProduct(product string) error {
	c.mu.Lock()
	if _, ok := c.cache[product]; ok {
		c.mu.Unlock()
		return nil
	}
	if cond, ok := c.loading[product]; ok {
		for c.loading[product] != nil {
			cond.Wait()
		}
		c.mu.Unlock()
		return nil
	}
	cond := sync.NewCond(&c.mu)
	c.loading[product] = cond
	c.mu.Unlock()

	prefix := "products/" + product + "/releases"
	files, err := c.storage.ListFiles(prefix)
	versions := map[string]ReleaseMeta{}
	if err == nil {
		for _, name := range files {
			if !strings.HasSuffix(name, "/meta.json") {
				continue
			}
			data, ok, readErr := c.storage.GetBytes(name)
			if readErr != nil || !ok {
				continue
			}
			var meta ReleaseMeta
			if json.Unmarshal(data, &meta) == nil && meta.Version != "" {
				if meta.Platforms == nil {
					meta.Platforms = map[string]PlatformFileInfo{}
				}
				versions[meta.Version] = meta
			}
		}
	}

	c.mu.Lock()
	c.cache[product] = versions
	delete(c.loading, product)
	cond.Broadcast()
	c.mu.Unlock()
	return err
}

func (c *ReleaseCache) Latest(product, channel, platform string) (*ReleaseMeta, error) {
	if err := c.ensureProduct(product); err != nil {
		return nil, err
	}
	c.mu.RLock()
	defer c.mu.RUnlock()
	versions := c.cache[product]
	items := make([]ReleaseMeta, 0, len(versions))
	for _, meta := range versions {
		if meta.Channel == channel {
			if _, ok := meta.Platforms[platform]; ok {
				items = append(items, meta)
			}
		}
	}
	sort.Slice(items, func(i, j int) bool {
		return CompareVersions(items[i].Version, items[j].Version) > 0
	})
	if len(items) == 0 {
		return nil, nil
	}
	meta := items[0]
	return &meta, nil
}

func (c *ReleaseCache) All(product string) ([]ReleaseMeta, error) {
	if err := c.ensureProduct(product); err != nil {
		return nil, err
	}
	c.mu.RLock()
	defer c.mu.RUnlock()
	versions := c.cache[product]
	items := make([]ReleaseMeta, 0, len(versions))
	for _, meta := range versions {
		items = append(items, meta)
	}
	sort.Slice(items, func(i, j int) bool {
		return CompareVersions(items[i].Version, items[j].Version) > 0
	})
	return items, nil
}

func (c *ReleaseCache) Set(product string, meta ReleaseMeta) {
	c.mu.Lock()
	defer c.mu.Unlock()
	versions := c.cache[product]
	if versions == nil {
		versions = map[string]ReleaseMeta{}
		c.cache[product] = versions
	}
	versions[meta.Version] = meta
}

func (c *ReleaseCache) Remove(product, version string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if versions := c.cache[product]; versions != nil {
		delete(versions, version)
	}
}

func (c *ReleaseCache) Invalidate(product string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.cache, product)
}
