(function () {
    'use strict';

    var SITE   = 'https://rezka-ua.co';
    var PLUGIN = 'HDRezka';
    var PROXY  = 'https://api.allorigins.win/raw?url=';

    // ── Мережа ──────────────────────────────────────────────────
    var corsOk = true;

    function fetchGet(url) {
        var direct = function () { return fetch(url).then(function (r) { return r.text(); }); };
        var proxy  = function () { return fetch(PROXY + encodeURIComponent(url)).then(function (r) { return r.text(); }); };
        if (!corsOk) return proxy();
        return direct().catch(function () { corsOk = false; return proxy(); });
    }

    function fetchPost(url, params) {
        var body = Object.keys(params).map(function (k) {
            return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
        }).join('&');

        var doPost = function () {
            return fetch(url, {
                method : 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' },
                body   : body
            }).then(function (r) { return r.json(); });
        };
        var doGet = function () {
            return fetch(PROXY + encodeURIComponent(url + '?' + body)).then(function (r) { return r.json(); });
        };

        if (!corsOk) return doGet();
        return doPost().catch(function () { corsOk = false; return doGet(); });
    }

    // ── Парсинг потоків ──────────────────────────────────────────
    function parseStreams(raw) {
        if (!raw) return [];
        var streams = [];
        var re = /\[([^\]]+)\](https?:\/\/[^\s,\[]+)/g;
        var m;
        while ((m = re.exec(raw)) !== null) {
            streams.push({ label: m[1], url: m[2].split(' or ')[0] });
        }
        if (!streams.length && /https?:\/\//.test(raw)) {
            streams.push({ label: 'Auto', url: raw.trim().split(' or ')[0] });
        }
        var order = ['2160p', '1080p Ultra', '1080p', '720p', '480p', '360p', 'Auto'];
        streams.sort(function (a, b) {
            var ai = order.indexOf(a.label);
            var bi = order.indexOf(b.label);
            return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
        });
        return streams;
    }

    // ── Парсинг сторінки тайтлу ──────────────────────────────────
    function parsePage(html) {
        var d = new DOMParser().parseFromString(html, 'text/html');

        var idM = html.match(/initCDN(?:Series|Movie)Events\((\d+)[,\s]/) ||
                  html.match(/"id_post"[:\s"]+(\d+)/);
        var titleId = idM ? idM[1] : '';

        var isSeries = !!d.querySelector('.b-simple_season__item');

        var translators = [];
        d.querySelectorAll('.b-translators__item, .b-translator__item').forEach(function (el) {
            var tid = el.dataset.translatorId || el.dataset.translator_id;
            if (tid) translators.push({ id: tid, name: el.textContent.trim() });
        });
        if (!translators.length) {
            var tm = html.match(/translator_id['":\s]+(\d+)/);
            if (tm) translators.push({ id: tm[1], name: 'Оригінал' });
        }

        var seasons = [];
        d.querySelectorAll('.b-simple_season__item').forEach(function (el) {
            seasons.push({ id: el.dataset.tab, name: el.textContent.trim() });
        });

        return { titleId: titleId, isSeries: isSeries, translators: translators, seasons: seasons };
    }

    // ── Пошук ────────────────────────────────────────────────────
    function search(query, page) {
        var url = SITE + '/search/?do=search&subaction=search&q=' +
                  encodeURIComponent(query) + '&page=' + (page || 1);
        return fetchGet(url).then(function (html) {
            var d = new DOMParser().parseFromString(html, 'text/html');
            var items = [];
            d.querySelectorAll('.b-content__inline_item').forEach(function (el) {
                var a   = el.querySelector('a.b-content__inline_item-link');
                var img = el.querySelector('img');
                if (!a) return;
                var hm = (a.href || '').match(/\/(\d+)-/);
                var tv = a.querySelector('div');
                items.push({
                    id    : hm ? hm[1] : '',
                    title : tv ? tv.textContent.trim() : a.textContent.trim(),
                    poster: img ? img.src : '',
                    url   : a.href
                });
            });
            return items;
        });
    }

    // ── Список епізодів ──────────────────────────────────────────
    function getEpisodes(titleId, translatorId, season) {
        return fetchPost(SITE + '/ajax/get_cdn_series/', {
            id: titleId, translator_id: translatorId,
            season: season, episode: 1, action: 'get_episodes'
        }).then(function (data) {
            if (!data.episodes) return [];
            var d = new DOMParser().parseFromString(data.episodes, 'text/html');
            var eps = [];
            d.querySelectorAll('.b-simple_episode__item').forEach(function (el) {
                eps.push({ id: el.dataset.episode, name: el.textContent.trim() });
            });
            return eps;
        });
    }

    // ── Відео-стрім ──────────────────────────────────────────────
    function getStream(titleId, translatorId, season, episode, isSeries) {
        var p = { id: titleId, translator_id: translatorId };
        var endpoint;
        if (isSeries) {
            p.season = season;
            p.episode = episode;
            p.action = 'get_stream';
            endpoint = '/ajax/get_cdn_series/';
        } else {
            p.action = 'get_movie';
            endpoint = '/ajax/get_cdn_movie/';
        }
        return fetchPost(SITE + endpoint, p).then(function (data) {
            if (!data.success) throw new Error(data.message || 'API error');
            return parseStreams(data.url);
        });
    }

    // ── Конвертація у картку Lampa ───────────────────────────────
    function toCard(item) {
        return {
            id            : 'rezka_' + item.id,
            _rezka_id     : item.id,
            _rezka_url    : item.url,
            title         : item.title,
            original_title: item.title,
            poster        : item.poster,
            poster_path   : item.poster,
            source        : PLUGIN
        };
    }

    // ── Lampa Source API ─────────────────────────────────────────
    var source = {

        search: function (params, oncomplete, onerror) {
            search(params.query, params.page).then(function (items) {
                oncomplete(items.map(toCard));
            }).catch(onerror);
        },

        full: function (card, oncomplete, onerror) {
            fetchGet(card._rezka_url).then(function (html) {
                card._rezka = parsePage(html);
                oncomplete(card);
            }).catch(onerror);
        },

        seasons: function (card, oncomplete, onerror) {
            if (!card._rezka) {
                return source.full(card, function () {
                    source.seasons(card, oncomplete, onerror);
                }, onerror);
            }
            var s = card._rezka.seasons;
            oncomplete(s.length ? s : [{ id: '1', name: 'Сезон 1' }]);
        },

        episodes: function (card, season, oncomplete, onerror) {
            var r   = card._rezka;
            var tid = r.translators.length ? r.translators[0].id : '0';
            getEpisodes(r.titleId, tid, season.id).then(oncomplete).catch(onerror);
        },

        voices: function (card, oncomplete) {
            var r = card._rezka;
            oncomplete(r && r.translators.length ? r.translators : [{ id: '0', name: 'Авто' }]);
        },

        play: function (card, params, oncomplete, onerror) {
            var r   = card._rezka;
            var is  = r.isSeries;
            var tid = (params.translator && params.translator.id) ||
                      (r.translators.length ? r.translators[0].id : '0');
            var s   = params.season  ? params.season.id  : 1;
            var ep  = params.episode ? params.episode.id : 1;

            getStream(r.titleId, tid, s, ep, is).then(function (streams) {
                if (!streams.length) return onerror('Потоки не знайдено');
                var quality = {};
                streams.forEach(function (s) { quality[s.label] = s.url; });
                oncomplete({
                    url     : streams[0].url,
                    title   : card.title,
                    quality : quality,
                    subtitles: []
                });
            }).catch(onerror);
        }
    };

    // ── Реєстрація ───────────────────────────────────────────────
    function register() {
        if (typeof Lampa === 'undefined') {
            setTimeout(register, 500);
            return;
        }

        // Lampa.Source (новий API)
        if (Lampa.Source && Lampa.Source.add) {
            Lampa.Source.add(PLUGIN, {
                name    : 'HDRezka',
                search  : source.search,
                full    : source.full,
                seasons : source.seasons,
                episodes: source.episodes,
                voices  : source.voices,
                play    : source.play
            });
        }

        // Lampa.Plugin (класичний API)
        if (Lampa.Plugin && Lampa.Plugin.add) {
            Lampa.Plugin.add(PLUGIN, function (plugin) {
                plugin.source = source;
                plugin.ready();
            });
        }

        console.log('[HDRezka] Плагін завантажено');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', register);
    } else {
        register();
    }

})();
