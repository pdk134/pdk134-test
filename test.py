import re
from unittest import result
 
text = "我的邮箱是 test@example.com"
# 错误写法:result = re.search(r"\w+@\w+\.\w+", text)
# 正确写法:
result = re.search(r"^\w+@\w+\.\w+$", text)
if result:
    print("邮箱格式正确")
else:
    print("邮箱格式错误")