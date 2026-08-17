#!/usr/bin/env python3
"""
開發用靜態伺服器：python3 scripts/serve.py [port]

跟 `python3 -m http.server` 一樣，只多送一個 Cache-Control: no-store。
少了它，瀏覽器會自己決定要不要用快取，常常變成
「index.html 是新的、app.js 還是舊的」——畫面上按鈕出現了，
點下去卻沒反應，因為 handler 在還沒更新的 app.js 裡。
"""

import functools
import http.server
import os
import sys

WWW = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'www')


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        super().end_headers()

    def send_header(self, keyword, value):
        # 送了 no-store 就別再送 Last-Modified，免得瀏覽器拿它做條件式請求
        if keyword == 'Last-Modified':
            return
        super().send_header(keyword, value)


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8788
    handler = functools.partial(NoCacheHandler, directory=os.path.normpath(WWW))
    print(f'http://localhost:{port}  （不走快取，改了檔案重整就看得到）')
    try:
        http.server.ThreadingHTTPServer(('', port), handler).serve_forever()
    except KeyboardInterrupt:
        print('\n收工')
