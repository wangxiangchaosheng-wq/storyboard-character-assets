#!/bin/zsh
cd -- "$(dirname "$0")" || exit 1
npm run dev:agents
result=$?
if [[ $result -ne 0 ]]; then
  echo "启动未完成，请保留上面的报错信息。按回车关闭。"
  read
fi
exit $result
